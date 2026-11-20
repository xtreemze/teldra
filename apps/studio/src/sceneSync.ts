// Renderer- and web-ifc-free live scene synchronisation (kept out of the initial shell chunk: no ifc-edit import).
import {
  SceneRegenerationCoordinator, type ElementTessellator, type RebuildReason, type SceneMeshApplyResult, type SceneMeshSink,
  type SceneMeshUpdate, type SceneRegenerationResult,
} from "@teldra/projection";
import type { TeldraSceneManifest } from "@teldra/scene-manifest";

/** The IFC read port the live scene needs; satisfied by `IfcModelCache` from `@teldra/ifc-edit`. */
export interface SceneModelCache {
  tessellator(bytes: Uint8Array, revisionKey: number): ElementTessellator;
  existingGlobalIds(bytes: Uint8Array, revisionKey: number, globalIds: Iterable<string>): ReadonlySet<string>;
  dispose(): void;
}
export type SceneSyncStatus =
  | { readonly state: "in-sync" }
  | { readonly state: "syncing" }
  /** The previous scene is still displayed; `retry()` re-attempts the pending elements. */
  | { readonly state: "degraded"; readonly message: string; readonly reason: "failed" | RebuildReason };

export interface SceneSyncApplied {
  readonly revision: number;
  /** Exact IFC bytes the applied meshes were generated from. */
  readonly bytes: Uint8Array;
  readonly generated: readonly string[];
  readonly removed: readonly string[];
}
export interface SceneSyncOptions {
  readonly manifest: TeldraSceneManifest;
  readonly sink: SceneMeshSink;
  readonly cache: SceneModelCache;
  /** Canonical IFC revision the loaded scene corresponds to. */
  readonly initialRevision: number;
  readonly resolveCanonicalId: (globalId: string) => string | undefined;
  /** A rendered GlobalId whose material a new element should reuse (the source of a duplicate). */
  readonly resolveMaterialSource?: (globalId: string) => string | undefined;
  readonly onApplied: (applied: SceneSyncApplied) => void;
  readonly onStatus?: (status: SceneSyncStatus) => void;
  readonly maxPatchElements?: number;
  /** Clock for stage timings (injectable for tests). */
  readonly now?: () => number;
}
/** Wall-clock stages of the most recent regeneration request, in milliseconds. */
export interface SceneSyncTimings { readonly revision: number; readonly tessellateMs: number; readonly applyMs: number; readonly totalMs: number }

/**
 * Live, revision-ordered synchronisation of the rendered scene with canonical IFC. One instance per loaded scene and
 * IFC editing session; it owns the IFC model cache (one open model per byte revision) and releases it on `dispose`.
 *
 * Contract: a result is applied only if no newer request has been issued meanwhile; a failing sink or an
 * unpatchable change keeps the previous scene, reports `degraded`, and keeps the affected ids pending so the next
 * request or an explicit `retry()` covers them.
 */
export class StudioSceneSync {
  readonly #options: SceneSyncOptions;
  readonly coordinator: SceneRegenerationCoordinator;
  readonly #snapshots = new Map<number, Uint8Array>();
  readonly #inflight = new Set<Promise<unknown>>();
  #status: SceneSyncStatus = { state: "in-sync" };
  #disposed = false;
  #lastRevision: number;
  #lastBytes: Uint8Array | undefined;
  #timings: SceneSyncTimings | undefined;
  #tessellateMs = 0;

  constructor(options: SceneSyncOptions) {
    this.#options = options;
    this.#lastRevision = options.initialRevision;
    this.coordinator = new SceneRegenerationCoordinator({
      nodes: options.manifest.nodes, canonicalToScene: options.manifest.scene.canonicalToScene,
      initialRevision: options.initialRevision, maxPatchElements: options.maxPatchElements ?? 512,
      resolveCanonicalId: options.resolveCanonicalId,
      ...(options.resolveMaterialSource ? { resolveMaterialSource: options.resolveMaterialSource } : {}),
      sink: { applyUpdate: (update, revision) => this.#apply(update, revision) },
    });
  }
  get status(): SceneSyncStatus { return this.#status; }
  get timings(): SceneSyncTimings | undefined { return this.#timings; }
  /** Canonical revision of the newest request issued (what the model is at), versus {@link reflectedRevision} (what is shown). */
  get requestedRevision(): number { return this.#lastRevision; }
  /** GlobalIds whose rendered geometry is obsolete: a canonical change is not (yet) reflected in the scene. */
  get staleGlobalIds(): readonly string[] { return this.coordinator.pendingGlobalIds.filter((id) => !this.#forced.has(id)); }
  /** Ids only re-tessellated by a deliberate full rebuild: their shown geometry was never known to be obsolete. */
  readonly #forced = new Set<string>();
  get reflectedRevision(): number { return this.coordinator.reflectedRevision; }
  /** True while the rendered scene has meshes for this canonical element and GlobalId. */
  renders(canonicalId: string, globalId: string): boolean {
    return this.coordinator.nodes.some((node) => node.canonicalId === canonicalId && node.ifcGlobalId === globalId);
  }
  /** Rendered GlobalIds, from the live node list (initial manifest plus applied patches). */
  renderedGlobalIds(): Set<string> {
    return new Set(this.coordinator.nodes.flatMap((node) => node.kind === "building" && node.ifcGlobalId !== undefined ? [node.ifcGlobalId] : []));
  }
  /** Resolves when every request issued so far has settled (applied, stale, or degraded). */
  async idle(): Promise<void> { while (this.#inflight.size) await Promise.allSettled([...this.#inflight]); }

  /** Regenerate `changed` elements from IFC snapshot `bytes` of canonical `revision`. */
  request(revision: number, bytes: Uint8Array, changed: readonly string[], maxPatchElements?: number): Promise<SceneRegenerationResult> {
    if (this.#disposed) return Promise.resolve({ status: "stale", revision, reflectedRevision: this.coordinator.reflectedRevision });
    this.#snapshots.set(revision, bytes);
    this.#lastRevision = Math.max(this.#lastRevision, revision); this.#lastBytes = bytes;
    this.#setStatus({ state: "syncing" });
    const base = this.#options.cache.tessellator(bytes, revision);
    const now = this.#options.now ?? (() => performance.now());
    const started = now();
    const promise = this.coordinator.request({
      revision, changedGlobalIds: changed, ...(maxPatchElements === undefined ? {} : { maxPatchElements }),
      // An IFC element that is not rendered and has no triangles (a storey, a space) is simply not part of the scene.
      tessellate: (ids) => {
        // A superseded or disposed session must never open a model (it would leak WASM memory for a dropped project).
        if (this.#disposed) throw new Error("The 3D session was closed.");
        const t0 = now();
        const meshes = new Map(base(ids)), live = this.renderedGlobalIds();
        this.#tessellateMs = now() - t0;
        for (const [id, mesh] of meshes) if (mesh && mesh.parts.length === 0 && !live.has(id)) meshes.set(id, null);
        return meshes;
      },
    }).then((result) => {
      if (result.status === "applied" || result.status === "noop")
        this.#timings = { revision, tessellateMs: this.#tessellateMs, applyMs: this.#applyMs, totalMs: now() - started };
      this.#settle(result); return result;
    }, (error) => {
      const result: SceneRegenerationResult = { status: "failed", revision, error };
      this.#settle(result); return result;
    });
    const tracked = promise.finally(() => { this.#inflight.delete(tracked); });
    this.#inflight.add(tracked);
    return promise;
  }
  /**
   * Deliberate full regeneration: every rendered element plus everything pending is re-tessellated from the latest
   * snapshot with no patch-size limit. The recovery path when incremental updates are refused or keep failing.
   */
  fullRebuild(): Promise<SceneRegenerationResult> {
    if (!this.#lastBytes) return Promise.resolve({ status: "noop", revision: this.#lastRevision });
    const pending = new Set(this.coordinator.pendingGlobalIds);
    const ids = new Set([...this.renderedGlobalIds(), ...pending]);
    for (const id of ids) if (!pending.has(id)) this.#forced.add(id);
    return this.request(this.#lastRevision, this.#lastBytes, [...ids], Number.POSITIVE_INFINITY);
  }
  /** Re-attempt every element still pending after a failure, from the latest snapshot. */
  retry(): Promise<SceneRegenerationResult> {
    if (!this.#lastBytes) return Promise.resolve({ status: "noop", revision: this.#lastRevision });
    return this.request(this.#lastRevision, this.#lastBytes, []);
  }
  /**
   * Reopen: make the rendered scene equal to canonical IFC without trusting the baked GLB. `wanted` are GlobalIds that
   * should be rendered but are not (saved copies); every rendered GlobalId the IFC no longer contains is removed.
   */
  reconcile(revision: number, bytes: Uint8Array, wanted: Iterable<string>, sourceBytes?: Uint8Array): Promise<SceneRegenerationResult> {
    const rendered = this.renderedGlobalIds();
    const exists = this.#options.cache.existingGlobalIds(bytes, revision, [...rendered, ...wanted]);
    let stale = [...rendered].filter((id) => !exists.has(id));
    // A rendered node whose GlobalId was never an IFC product (presentation geometry, grouping ids) is not "deleted":
    // only elements the source IFC (what the GLB was baked from) had and the current IFC no longer has are removed.
    if (stale.length && sourceBytes) {
      const before = this.#options.cache.existingGlobalIds(sourceBytes, -1, stale);
      stale = stale.filter((id) => before.has(id));
    }
    const missing = [...wanted].filter((id) => exists.has(id) && !rendered.has(id));
    return this.request(revision, bytes, [...stale, ...missing]);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#options.cache.dispose();
    this.#snapshots.clear();
  }

  #applyMs = 0;
  #apply(update: SceneMeshUpdate, revision: number): SceneMeshApplyResult {
    // Results computed for a project that has since been closed or replaced must not touch any viewport.
    if (this.#disposed) return { ok: false, error: new Error("The 3D session was closed.") };
    const now = this.#options.now ?? (() => performance.now());
    const t0 = now();
    const result = this.#options.sink.applyUpdate(update, revision);
    this.#applyMs = now() - t0;
    if (!result.ok) return result;
    const bytes = this.#snapshots.get(revision);
    try {
      this.#options.onApplied({ revision, bytes: bytes ?? new Uint8Array(),
        generated: [...update.replace, ...update.add].map((e) => e.globalId), removed: update.remove.map((e) => e.globalId) });
    } catch (error) { this.#setStatus({ state: "degraded", reason: "failed", message: `3D view updated, but its editing baseline did not: ${messageOf(error)}` }); }
    return result;
  }
  #settle(result: SceneRegenerationResult): void {
    if (this.#disposed) return;
    if (result.status === "applied" || result.status === "noop") this.#forced.clear();
    for (const key of [...this.#snapshots.keys()]) if (key < this.coordinator.reflectedRevision) this.#snapshots.delete(key);
    if (result.status === "applied" || result.status === "noop") {
      if (this.#inflight.size <= 1) this.#setStatus({ state: "in-sync" });
    } else if (result.status === "failed") {
      this.#setStatus({ state: "degraded", reason: "failed", message: `The 3D view could not be updated: ${messageOf(result.error)}. The previous scene is still shown.` });
    } else if (result.status === "rebuild-required") {
      this.#setStatus({ state: "degraded", reason: result.reason, message: `The 3D view needs a rebuild (${result.detail}). The previous scene is still shown.` });
    } else if (this.#inflight.size <= 1 && this.#status.state === "syncing") this.#setStatus({ state: "in-sync" });
  }
  #setStatus(status: SceneSyncStatus): void {
    const same = this.#status.state === status.state && (status.state !== "degraded" || (this.#status as typeof status).message === status.message);
    this.#status = status;
    if (!same) this.#options.onStatus?.(status);
  }
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
