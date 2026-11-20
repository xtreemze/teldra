import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import { canonicalTwinFingerprint } from "@teldra/application";
import { assertTwinIntegrity, type TwinProject } from "@teldra/domain";
import { openProjectPersistence, type ProjectStorageAdapter, type StoredProject } from "@teldra/project-format";
import type { ElementMesh, SceneMeshSink, SceneMeshUpdate } from "@teldra/projection";
import type { TeldraSceneManifest } from "@teldra/scene-manifest";
import { StudioProjectController, type SceneRenderer } from "./StudioProjectController";
import { StudioSceneSync, type SceneModelCache } from "./sceneSync";

class MemoryStorage implements ProjectStorageAdapter<TwinProject> {
  primary: StoredProject<TwinProject> | null; backup = null; recovery = null; staged: StoredProject<TwinProject> | null = null;
  constructor(primary: StoredProject<TwinProject>) { this.primary = structuredClone(primary); }
  async acquireWriteLock() { return true; }
  async releaseWriteLock() {}
  async readPrimary() { return structuredClone(this.primary); }
  async readBackup() { return null; }
  async readRecovery() { return null; }
  async stagePrimary(_k: string, _o: string, project: StoredProject<TwinProject>) { this.staged = structuredClone(project); return "s"; }
  async commitStaged() { this.primary = structuredClone(this.staged); this.staged = null; }
  async discardStaged() { this.staged = null; }
  async writeRecovery() {}
  async clearRecovery() {}
}

interface Doc { elements: Record<string, { pose: { position: [number, number, number]; yawRadians: number }; name: string; scale?: [number, number, number] }> }
const enc = new TextEncoder(), dec = new TextDecoder();
const put = (d: Doc) => enc.encode(JSON.stringify(d)), get = (b: Uint8Array) => JSON.parse(dec.decode(b)) as Doc;
const chairGuid = "16W6mYG0DO8hR8U$bz6FSv", lampGuid = "0ufYQjmwP0Ah$QRRxVbqR3";
const Y_UP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const adapter = {
  read: (b: Uint8Array, id: string) => { const e = get(b).elements[id]; if (!e) throw new Error("missing " + id); return e.pose; },
  write: (b: Uint8Array, id: string, pose: any) => { const d = get(b); d.elements[id]!.pose = pose; return put(d); },
  readScale: (b: Uint8Array, id: string) => { const e = get(b).elements[id]; if (!e?.scale) throw new Error("no scale"); return e.scale; },
  writeScale: (b: Uint8Array, id: string, scale: any) => { const d = get(b); d.elements[id]!.scale = scale; return put(d); },
  duplicate: (b: Uint8Array, id: string, newId: string, o?: { offset?: readonly number[]; name?: string }) => {
    const d = get(b); const s = d.elements[id]!; const off = o?.offset ?? [0, 0, 0];
    d.elements[newId] = { name: o?.name ?? s.name, ...(s.scale ? { scale: s.scale } : {}), pose: { position: [s.pose.position[0] + off[0]!, s.pose.position[1] + off[1]!, s.pose.position[2] + off[2]!], yawRadians: s.pose.yawRadians } };
    return put(d);
  },
  remove: (b: Uint8Array, id: string) => { const d = get(b); delete d.elements[id]; return put(d); },
};

/** Fake IFC read model: one triangle per element at its pose; counts opens/disposals and tessellation calls. */
class FakeCache implements SceneModelCache {
  opens = 0; disposed = 0; tessellations: string[][] = []; keys = new Set<number>();
  tessellator(bytes: Uint8Array, key: number) {
    return (ids: readonly string[]) => {
      if (!this.keys.has(key)) { this.keys.add(key); this.opens++; }
      this.tessellations.push([...ids]);
      const doc = get(bytes);
      return new Map(ids.map((id): [string, ElementMesh | null] => {
        const e = doc.elements[id]; if (!e) return [id, null];
        const [x, y, z] = e.pose.position;
        return [id, { globalId: id, parts: [{ positions: new Float32Array([x, y, z, x + 1, y, z, x, y + 1, z + 1]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]), color: [0.5, 0.5, 0.5, 1] }] }];
      }));
    };
  }
  existingGlobalIds(bytes: Uint8Array, key: number, ids: Iterable<string>) {
    if (!this.keys.has(key)) { this.keys.add(key); this.opens++; }
    const doc = get(bytes); return new Set([...ids].filter(id => id in doc.elements));
  }
  dispose() { this.disposed++; }
}
/** Fake viewport: remembers rendered elements, material sources, and live mesh counts. */
class FakeViewport implements SceneMeshSink {
  rendered = new Map<string, { revision: number; x: number; materialFrom?: string }>(); updates: SceneMeshUpdate[] = []; failNext = 0; calls = 0;
  applyUpdate(update: SceneMeshUpdate, revision: number) {
    this.calls++;
    if (this.failNext > 0) { this.failNext--; return { ok: false as const, error: new Error("viewport lost") }; }
    this.updates.push(update);
    for (const e of [...update.replace, ...update.add]) this.rendered.set(e.globalId, { revision, x: e.parts[0]!.positions[0]!, ...(e.materialSourceGlobalId ? { materialFrom: e.materialSourceGlobalId } : {}) });
    for (const e of update.remove) this.rendered.delete(e.globalId);
    return { ok: true as const };
  }
}

const fixture = goldenTwin as TwinProject;
const manifest = (nodes: { canonicalId: string; ifcGlobalId: string }[]) => ({
  schemaVersion: "0.1.0", coordinateSystem: { unit: "metre", handedness: "right", upAxis: "Z" },
  source: { buildingPath: "building.ifc", buildingSha256: "a".repeat(64) },
  scene: { assetPath: "scene.glb", assetSha256: "b".repeat(64), format: "glb", canonicalToScene: Y_UP },
  nodes: nodes.map(n => ({ nodeKey: `ifc:${n.ifcGlobalId}:body`, kind: "building" as const, ...n })),
}) as unknown as TeldraSceneManifest;

async function setup(opts: { doc?: Doc; sourceDoc?: Doc; extraRefs?: { id: string; ifcGlobalId: string; kind: "furniture"; name?: string }[]; nodes?: { canonicalId: string; ifcGlobalId: string }[]; viewport?: FakeViewport; cache?: FakeCache; ifc?: any } = {}) {
  const twin = structuredClone(fixture);
  twin.building.refs.push({ id: "chair", ifcGlobalId: chairGuid, kind: "furniture", name: "Chair" }, ...(opts.extraRefs ?? []));
  const storage = new MemoryStorage({ revision: 0, fingerprint: canonicalTwinFingerprint(twin), canonical: twin });
  const opened = await openProjectPersistence(storage, assertTwinIntegrity, "regen", "test:regen");
  const base: Doc = { elements: { [chairGuid]: { name: "Chair", pose: { position: [1, -1, 0], yawRadians: 0 }, scale: [1, 1, 1] }, [lampGuid]: { name: "Lamp", pose: { position: [2, 2, 0], yawRadians: 0 } } } };
  const doc = opts.doc ?? base, sourceDoc = opts.sourceDoc ?? base;
  const nodes = opts.nodes ?? [{ canonicalId: "chair", ifcGlobalId: chairGuid }, { canonicalId: "fixture:living-room-floor-lamp", ifcGlobalId: lampGuid }];
  const cache = opts.cache ?? new FakeCache(), viewport = opts.viewport ?? new FakeViewport();
  for (const n of nodes) viewport.rendered.set(n.ifcGlobalId, { revision: -1, x: 0 });
  const scene = manifest(nodes);
  const controller = new StudioProjectController(twin, opened.session, {
    bytes: put(doc), sourceBytes: put(sourceDoc), placements: [],
    scene: scene as any, createAdapter: async () => opts.ifc ?? adapter, createModelCache: async () => cache,
  });
  const renderer: SceneRenderer = { sink: viewport, manifest: scene };
  return { controller, storage, cache, viewport, renderer, scene };
}

describe("Studio scene regeneration: duplicate, delete, undo, redo", () => {
  it("duplicate regenerates the copy as a real mesh that borrows the source material, and is editable against its baked baseline", async () => {
    const { controller, viewport, renderer, cache } = await setup();
    await controller.attachSceneRenderer(renderer);
    expect(cache.opens).toBe(0); // GLB already equals IFC: nothing opened, nothing regenerated
    const copyId = await controller.duplicateFurniture("chair");
    await controller.sceneIdle();
    const copyGuid = controller.twin.building.refs.find(r => r.id === copyId)!.ifcGlobalId;
    expect(viewport.updates).toHaveLength(1);
    expect(viewport.updates[0]!.add.map(e => ({ id: e.canonicalId, from: e.materialSourceGlobalId }))).toEqual([{ id: copyId, from: chairGuid }]);
    expect(viewport.rendered.get(copyGuid)).toMatchObject({ materialFrom: chairGuid });
    expect(controller.isSceneBacked(copyId)).toBe(true);
    expect(controller.renderedRevision).toBe(controller.revision); // model revision == rendered revision
    expect(controller.sceneSyncStatus).toEqual({ state: "in-sync" });
    // gizmo-editable: baseline = where the mesh is baked; no delta until moved
    const placement = await controller.prepareFurnitureEditing(copyId).then(() => controller.furniturePlacement(copyId));
    expect(placement.original.position[0]).toBeCloseTo(1.5);
    expect(controller.liveSceneOverrides.map(o => o.canonicalId)).not.toContain(copyId);
    controller.placeFurniture(copyId, { position: [4, 0, 0], yawRadians: 0 });
    const live = controller.liveSceneOverrides.find(o => o.canonicalId === copyId)!;
    expect(live.matrix[12]).toBeCloseTo(2.5); // 4 - 1.5, relative to the regenerated baseline
    expect(controller.placementOverrides.map(o => o.canonicalId)).not.toContain(copyId); // never persisted against the GLB
    expect(controller.furnitureScaleStatus(copyId)).toEqual({ supported: true, scale: [1, 1, 1] });
  });

  it("delete removes the mesh, drops only that selection, and undo/redo re-add/remove it with the source untouched", async () => {
    const { controller, viewport, renderer } = await setup();
    await controller.attachSceneRenderer(renderer);
    controller.selectCanonicalId("chair");
    await controller.removeFurniture("chair"); await controller.sceneIdle();
    expect(viewport.rendered.has(chairGuid)).toBe(false);
    expect(viewport.rendered.has(lampGuid)).toBe(true); // unaffected geometry preserved
    expect(controller.selectedCanonicalId).toBeNull();
    controller.selectCanonicalId("fixture:living-room-floor-lamp");
    controller.undo(); await controller.sceneIdle();
    expect(viewport.rendered.get(chairGuid)).toBeDefined();
    expect(controller.selectedCanonicalId).toBe("fixture:living-room-floor-lamp"); // a surviving selection is kept
    expect(controller.isSceneBacked("chair")).toBe(true);
    controller.redo(); await controller.sceneIdle();
    expect(viewport.rendered.has(chairGuid)).toBe(false);
    expect(controller.renderedRevision).toBe(controller.revision);
  });

  it("undo of a duplicate removes the copy mesh; redo restores it with the same canonical identity and material source", async () => {
    const { controller, viewport, renderer } = await setup();
    await controller.attachSceneRenderer(renderer);
    const copyId = await controller.duplicateFurniture("chair"); await controller.sceneIdle();
    const copyGuid = controller.twin.building.refs.find(r => r.id === copyId)!.ifcGlobalId;
    controller.selectCanonicalId(copyId);
    controller.undo(); await controller.sceneIdle();
    expect(viewport.rendered.has(copyGuid)).toBe(false);
    expect(controller.selectedCanonicalId).toBeNull();
    controller.redo(); await controller.sceneIdle();
    expect(viewport.rendered.get(copyGuid)).toMatchObject({ materialFrom: chairGuid });
    expect(controller.twin.building.refs.find(r => r.id === copyId)!.ifcGlobalId).toBe(copyGuid);
  });

  it("a restored element is baked at its IFC pose: the live delta is zero, the persisted delta is still against the original GLB", async () => {
    const { controller, renderer, storage } = await setup();
    await controller.attachSceneRenderer(renderer);
    await controller.prepareFurnitureEditing("chair");
    controller.placeFurniture("chair", { position: [3, -1, 0], yawRadians: 0 });
    expect(controller.liveSceneOverrides.find(o => o.canonicalId === "chair")!.matrix[12]).toBeCloseTo(2);
    await controller.removeFurniture("chair"); await controller.sceneIdle();
    controller.undo(); await controller.sceneIdle(); // chair regenerated at x=3
    expect(controller.liveSceneOverrides.find(o => o.canonicalId === "chair")).toBeUndefined();
    await expect(Promise.resolve().then(() => controller.placeFurniture("chair", { position: [9, 0, 0], yawRadians: 0 }))).rejects.toThrow(/Prepare IFC editing first/);
    await controller.prepareFurnitureEditing("chair"); // resolves the pending baseline from current IFC (x=3)
    expect(controller.placementOverrides.find(o => o.canonicalId === "chair")!.matrix[12]).toBeCloseTo(2);
    controller.placeFurniture("chair", { position: [5, -1, 0], yawRadians: 0 });
    expect(controller.liveSceneOverrides.find(o => o.canonicalId === "chair")!.matrix[12]).toBeCloseTo(2); // 5 - 3
    expect(controller.placementOverrides.find(o => o.canonicalId === "chair")!.matrix[12]).toBeCloseTo(4); // 5 - 1
    await controller.save();
    expect(storage.primary).not.toBeNull();
  });

  it("stays headless-safe: without a renderer nothing is regenerated and edits behave as before", async () => {
    const { controller, cache } = await setup();
    const copyId = await controller.duplicateFurniture("chair");
    await controller.sceneIdle();
    expect(cache.opens).toBe(0);
    expect(controller.isSceneBacked(copyId)).toBe(false);
    expect(controller.renderedRevision).toBeNull();
  });
});

describe("overlapping edits", () => {
  it("a superseded request is cancelled before it tessellates; the newest covers both elements", async () => {
    const { controller, viewport, renderer, cache } = await setup();
    await controller.attachSceneRenderer(renderer);
    const first = await controller.duplicateFurniture("chair");
    const second = await controller.duplicateFurniture("fixture:living-room-floor-lamp");
    await controller.sceneIdle();
    expect(viewport.updates).toHaveLength(1);
    expect(cache.tessellations).toHaveLength(1); // the obsolete request never ran its (expensive) tessellation
    expect(controller.isSceneBacked(first) && controller.isSceneBacked(second)).toBe(true);
    expect(controller.renderedRevision).toBe(controller.revision);
  });
});

describe("failure keeps the old scene, marks it stale, and recovers", () => {
  it("a failed update never presents obsolete geometry as current: stale status, blocked editing, then automatic full rebuild", async () => {
    const viewport = new FakeViewport(); viewport.failNext = 1;
    const { controller, renderer } = await setup({ viewport });
    await controller.attachSceneRenderer(renderer);
    const seen: string[] = [];
    controller.onSceneChange(() => seen.push(controller.sceneSyncStatus.state));
    const copyId = await controller.duplicateFurniture("chair");
    await new Promise(resolve => setTimeout(resolve, 0)); // let the failed request settle, before the auto-rebuild finishes
    await controller.sceneIdle();
    expect(seen).toContain("degraded"); // visible status at the point of failure
    expect(viewport.calls).toBeGreaterThanOrEqual(2); // failed once, then auto rebuild
    expect(controller.sceneSyncStatus).toEqual({ state: "in-sync" });
    expect(controller.isSceneBacked(copyId)).toBe(true);
    expect(controller.renderedRevision).toBe(controller.revision);
  });
  it("while stale the affected element is not editable through its (obsolete) mesh, the model/rendered revisions differ, and retry recovers", async () => {
    const viewport = new FakeViewport(); viewport.failNext = 2; // incremental + the automatic full rebuild both fail
    const { controller, renderer } = await setup({ viewport });
    await controller.attachSceneRenderer(renderer);
    const before = controller.renderedRevision!;
    const copyId = await controller.duplicateFurniture("chair");
    await controller.sceneIdle(); await new Promise(resolve => setTimeout(resolve, 0)); await controller.sceneIdle();
    const status = controller.sceneSyncStatus;
    expect(status.state).toBe("degraded");
    expect(status.state === "degraded" && status.message).toMatch(/previous scene is still shown/);
    expect(controller.renderedRevision).toBe(before);
    expect(controller.revision).toBeGreaterThan(controller.renderedRevision!);
    expect(controller.isSceneStale(copyId)).toBe(true);
    expect(controller.isSceneBacked(copyId)).toBe(false); // no gizmo / projection against a missing or obsolete mesh
    expect(controller.isSceneBacked("chair")).toBe(true); // unaffected geometry stays interactive
    await controller.retrySceneSync();
    expect(controller.sceneSyncStatus).toEqual({ state: "in-sync" });
    expect(controller.isSceneStale(copyId)).toBe(false);
    expect(controller.isSceneBacked(copyId)).toBe(true);
    expect(controller.renderedRevision).toBe(controller.revision);
  });
  it("the canonical edit is never rolled back by a rendering failure", async () => {
    const viewport = new FakeViewport(); viewport.failNext = 99;
    const { controller, renderer } = await setup({ viewport });
    await controller.attachSceneRenderer(renderer);
    const copyId = await controller.duplicateFurniture("chair");
    await controller.sceneIdle(); await new Promise(resolve => setTimeout(resolve, 0)); await controller.sceneIdle();
    expect(controller.twin.building.refs.some(r => r.id === copyId)).toBe(true);
    expect(controller.dirty).toBe(true);
    expect(controller.sceneSyncStatus.state).toBe("degraded");
  });
});

describe("project lifecycle", () => {
  it("closing the scene while regeneration is in flight drops its result and disposes the model cache exactly once", async () => {
    const { controller, viewport, renderer, cache } = await setup();
    await controller.attachSceneRenderer(renderer);
    await controller.duplicateFurniture("chair");
    controller.detachSceneRenderer(); // project switched / closed before the async request ran
    await controller.sceneIdle();
    expect(viewport.updates).toHaveLength(0);
    expect(viewport.calls).toBe(0);
    expect(cache.disposed).toBe(1);
    expect(controller.sceneSyncStatus).toEqual({ state: "in-sync" });
  });
  it("a new project's controller is independent: no cross-talk with an old one's viewport", async () => {
    const a = await setup(), b = await setup();
    await a.controller.attachSceneRenderer(a.renderer); await b.controller.attachSceneRenderer(b.renderer);
    await a.controller.duplicateFurniture("chair"); a.controller.detachSceneRenderer();
    await b.controller.duplicateFurniture("chair"); await b.controller.sceneIdle(); await a.controller.sceneIdle();
    expect(a.viewport.updates).toHaveLength(0);
    expect(b.viewport.updates).toHaveLength(1);
  });
});

describe("reopen: the render set is derived from canonical IFC and the twin, not from the baked GLB", () => {
  const savedDoc = (): Doc => ({ elements: {
    [lampGuid]: { name: "Lamp", pose: { position: [2, 2, 0], yawRadians: 0 } },
    "2gEfmKcdn6c9fX3LLRJBkX": { name: "Chair (copy)", pose: { position: [1.5, -1, 0], yawRadians: 0 }, scale: [1, 1, 1] },
  } });
  it("removes baked meshes of elements absent from IFC and regenerates saved copies that have no baked mesh", async () => {
    const copyGuid = "2gEfmKcdn6c9fX3LLRJBkX";
    const { controller, viewport, renderer } = await setup({
      doc: savedDoc(),
      extraRefs: [{ id: "chair-copy", ifcGlobalId: copyGuid, kind: "furniture", name: "Chair (copy)" }],
    });
    // The twin of the saved project no longer holds the deleted chair; the GLB still carries its mesh.
    (controller.twin as TwinProject).building.refs.splice((controller.twin as TwinProject).building.refs.findIndex(r => r.id === "chair"), 1);
    await controller.attachSceneRenderer(renderer);
    expect(viewport.rendered.has(chairGuid)).toBe(false);
    expect(viewport.rendered.has(copyGuid)).toBe(true);
    expect(viewport.rendered.has(lampGuid)).toBe(true);
    expect(controller.isSceneBacked("chair-copy")).toBe(true);
    expect(viewport.updates.flatMap(u => u.remove.map(e => e.globalId))).toEqual([chairGuid]);
    expect(viewport.updates.flatMap(u => u.add.map(e => e.globalId))).toEqual([copyGuid]);
  });
  it("opens the saved IFC once for existence and tessellation; the source IFC is consulted only to confirm a deletion", async () => {
    const copyGuid = "2gEfmKcdn6c9fX3LLRJBkX";
    const { controller, renderer, cache } = await setup({ doc: savedDoc(), extraRefs: [{ id: "chair-copy", ifcGlobalId: copyGuid, kind: "furniture" }] });
    await controller.attachSceneRenderer(renderer);
    expect(cache.opens).toBe(2); // saved IFC (shared by existence + tessellation) + source IFC (one candidate deletion)
  });
  it("never removes a rendered node whose GlobalId was not an IFC element in the source either (presentation geometry)", async () => {
    const copyGuid = "2gEfmKcdn6c9fX3LLRJBkX";
    const { controller, viewport, renderer } = await setup({
      doc: savedDoc(), extraRefs: [{ id: "chair-copy", ifcGlobalId: copyGuid, kind: "furniture" }],
      nodes: [{ canonicalId: "chair", ifcGlobalId: chairGuid }, { canonicalId: "fixture:living-room-floor-lamp", ifcGlobalId: lampGuid }, { canonicalId: "presentation:ground", ifcGlobalId: "0NotAnIfcProductAAAAAAA1" }],
    });
    await controller.attachSceneRenderer(renderer);
    expect(viewport.rendered.has("0NotAnIfcProductAAAAAAA1")).toBe(true);
    expect(viewport.rendered.has(chairGuid)).toBe(false);
  });
});

describe("StudioSceneSync", () => {
  const nodes = [{ canonicalId: "chair", ifcGlobalId: chairGuid }, { canonicalId: "fixture:living-room-floor-lamp", ifcGlobalId: lampGuid }];
  const doc: Doc = { elements: { [chairGuid]: { name: "Chair", pose: { position: [1, 0, 0], yawRadians: 0 } }, [lampGuid]: { name: "Lamp", pose: { position: [2, 0, 0], yawRadians: 0 } } } };
  const make = (extra: Partial<ConstructorParameters<typeof StudioSceneSync>[0]> = {}, viewport = new FakeViewport(), cache = new FakeCache()) => ({
    viewport, cache,
    sync: new StudioSceneSync({ manifest: manifest(nodes), sink: viewport, cache, initialRevision: 0,
      resolveCanonicalId: guid => nodes.find(n => n.ifcGlobalId === guid)?.canonicalId, onApplied: () => {}, ...extra }),
  });
  it("full rebuild succeeds where the incremental patch is refused, then the scene is in sync", async () => {
    const { sync, viewport } = make({ maxPatchElements: 1 });
    const result = await sync.request(1, put(doc), [chairGuid, lampGuid]);
    expect(result.status).toBe("rebuild-required");
    expect(sync.status.state).toBe("degraded");
    expect([...sync.staleGlobalIds].sort()).toEqual([chairGuid, lampGuid].sort());
    expect(viewport.updates).toHaveLength(0); // previous scene kept
    expect((await sync.fullRebuild()).status).toBe("applied");
    expect(sync.status).toEqual({ state: "in-sync" });
    expect(sync.staleGlobalIds).toEqual([]);
    expect(sync.reflectedRevision).toBe(1);
  });
  it("regeneration keeps canonical identity (and so a bound fixture's binding) while replacing geometry", async () => {
    const { sync, viewport } = make();
    await sync.request(1, put({ elements: { ...doc.elements, [lampGuid]: { name: "Lamp", pose: { position: [9, 0, 0], yawRadians: 0 } } } }), [lampGuid]);
    expect(viewport.updates[0]!.replace.map(e => e.canonicalId)).toEqual(["fixture:living-room-floor-lamp"]);
    expect(viewport.updates[0]!.replace[0]!.parts[0]!.node).toMatchObject({ canonicalId: "fixture:living-room-floor-lamp", ifcGlobalId: lampGuid });
    expect(fixture.bindings.some(b => b.deviceId === "device:living-room-floor-lamp")).toBe(true);
  });
  it("records stage timings of the last regeneration", async () => {
    let t = 0;
    const { sync } = make({ now: () => (t += 5) });
    await sync.request(1, put(doc), [chairGuid]);
    expect(sync.timings).toMatchObject({ revision: 1 });
    expect(sync.timings!.totalMs).toBeGreaterThan(0);
  });
  it("tessellation of a disposed session never opens a model", async () => {
    const { sync, cache } = make();
    const pending = sync.request(1, put(doc), [chairGuid]);
    sync.dispose();
    await pending;
    expect(cache.opens).toBe(0);
    expect(cache.disposed).toBe(1);
  });
});
