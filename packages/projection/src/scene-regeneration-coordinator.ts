import {
  planSceneRegeneration, type ElementMesh, type Matrix4, type RebuildReason, type SceneMeshUpdate, type SceneNodeRecord,
} from "./scene-regeneration.js";

/** Tessellator that may be asynchronous (e.g. a worker); results are revision-checked after awaiting. */
export type AsyncElementTessellator = (globalIds: readonly string[]) =>
  ReadonlyMap<string, ElementMesh | null> | Promise<ReadonlyMap<string, ElementMesh | null>>;

export type SceneMeshApplyResult = { readonly ok: true } | { readonly ok: false; readonly error: unknown };
/** Renderer adapter port. Must be atomic: on `ok: false` the previous scene is untouched. */
export interface SceneMeshSink { applyUpdate(update: SceneMeshUpdate, revision: number): SceneMeshApplyResult }

export interface SceneRegenerationRequest {
  /** Canonical IFC history revision (`IfcWallEditor.history.revision`) the bytes behind `tessellate` correspond to. */
  readonly revision: number;
  readonly changedGlobalIds: readonly string[];
  /** Must read the IFC snapshot of exactly `revision`. */
  readonly tessellate: AsyncElementTessellator;
}
export type SceneRegenerationResult =
  | { readonly status: "applied"; readonly revision: number; readonly elements: readonly string[] }
  | { readonly status: "noop"; readonly revision: number }
  /** Discarded: an equal/newer revision is already reflected, or a newer request superseded this one. */
  | { readonly status: "stale"; readonly revision: number; readonly reflectedRevision: number }
  /** Caller must fully rebuild the scene, then call {@link SceneRegenerationCoordinator.markRebuilt}. */
  | { readonly status: "rebuild-required"; readonly revision: number; readonly reason: RebuildReason; readonly detail: string }
  /** The previous scene is retained; ids stay dirty so the next request retries them. */
  | { readonly status: "failed"; readonly revision: number; readonly error: unknown };

export interface SceneRegenerationCoordinatorOptions {
  readonly nodes: readonly SceneNodeRecord[];
  readonly canonicalToScene: Matrix4;
  /** Canonical revision the currently loaded scene corresponds to. */
  readonly initialRevision: number;
  readonly sink: SceneMeshSink;
  readonly resolveCanonicalId?: (globalId: string) => string | undefined;
  readonly maxPatchElements?: number;
}

/**
 * Serialises scene regeneration against canonical IFC revisions.
 *
 * - Every request names the revision whose bytes it tessellates; the coordinator exposes the
 *   revision the scene reflects ({@link reflectedRevision}).
 * - Changed ids accumulate as "dirty" until a revision containing them is applied, so
 *   overlapping/out-of-order requests cannot lose an element: a superseded request is discarded
 *   and its ids are regenerated from the newest snapshot.
 * - A result is applied only if no newer request arrived while it was computed.
 */
export class SceneRegenerationCoordinator {
  readonly #options: SceneRegenerationCoordinatorOptions;
  #nodes: SceneNodeRecord[];
  #reflected: number;
  #latest: number;
  readonly #dirty = new Set<string>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: SceneRegenerationCoordinatorOptions) {
    this.#options = options;
    this.#nodes = [...options.nodes];
    this.#reflected = this.#latest = options.initialRevision;
  }
  /** Canonical IFC revision the rendered scene currently reflects. */
  get reflectedRevision(): number { return this.#reflected; }
  get nodes(): readonly SceneNodeRecord[] { return this.#nodes; }
  get pendingGlobalIds(): readonly string[] { return [...this.#dirty]; }

  request(request: SceneRegenerationRequest): Promise<SceneRegenerationResult> {
    const { revision } = request;
    if (!Number.isInteger(revision) || revision < 0) return Promise.reject(new TypeError("Revision must be a non-negative integer."));
    if (revision <= this.#reflected || revision < this.#latest)
      return Promise.resolve({ status: "stale", revision, reflectedRevision: this.#reflected });
    // Register synchronously so a later-queued, earlier-computed result can detect supersession.
    for (const id of request.changedGlobalIds) this.#dirty.add(id);
    this.#latest = revision;
    const run = this.#chain.then(() => this.#run(request));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** After a full rebuild from the bytes of `revision`: adopt the rebuilt manifest nodes and clear pending work. */
  markRebuilt(revision: number, nodes: readonly SceneNodeRecord[]): void {
    this.#nodes = [...nodes];
    this.#reflected = revision;
    this.#latest = Math.max(this.#latest, revision);
    this.#dirty.clear();
  }

  async #run(request: SceneRegenerationRequest): Promise<SceneRegenerationResult> {
    const { revision } = request;
    const stale = (): SceneRegenerationResult => ({ status: "stale", revision, reflectedRevision: this.#reflected });
    if (revision <= this.#reflected || revision < this.#latest) return stale();
    const ids = [...this.#dirty];
    let loaded: ReadonlyMap<string, ElementMesh | null> | undefined, loadError: unknown;
    try { loaded = await request.tessellate(ids); } catch (error) { loadError = error; }
    if (revision < this.#latest || revision <= this.#reflected) return stale();
    const plan = planSceneRegeneration({
      nodes: this.#nodes, canonicalToScene: this.#options.canonicalToScene, changedGlobalIds: ids,
      tessellate: () => { if (!loaded) throw loadError ?? new Error("Tessellation unavailable."); return loaded; },
      ...(this.#options.resolveCanonicalId ? { resolveCanonicalId: this.#options.resolveCanonicalId } : {}),
      ...(this.#options.maxPatchElements === undefined ? {} : { maxPatchElements: this.#options.maxPatchElements }),
    });
    if (plan.kind === "rebuild") return { status: "rebuild-required", revision, reason: plan.reason, detail: plan.detail };
    if (plan.kind === "noop") { this.#settle(revision, ids); return { status: "noop", revision }; }
    let applied: SceneMeshApplyResult;
    try { applied = this.#options.sink.applyUpdate(plan.update, revision); }
    catch (error) { applied = { ok: false, error }; }
    if (!applied.ok) return { status: "failed", revision, error: applied.error };
    const { replace, add, remove } = plan.update;
    const dropped = new Set([...replace.flatMap((e) => e.previousNodeKeys), ...remove.flatMap((e) => e.nodeKeys)]);
    this.#nodes = [...this.#nodes.filter((node) => !dropped.has(node.nodeKey)),
      ...[...replace, ...add].flatMap((element) => element.parts.map((part) => part.node))];
    this.#settle(revision, ids);
    return { status: "applied", revision, elements: [...replace, ...add].map((e) => e.globalId).concat(remove.map((e) => e.globalId)) };
  }
  #settle(revision: number, ids: readonly string[]): void {
    this.#reflected = revision;
    for (const id of ids) this.#dirty.delete(id);
  }
}
