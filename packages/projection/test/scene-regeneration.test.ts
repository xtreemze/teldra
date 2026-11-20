import { describe, expect, it } from "vitest";
import {
  planSceneRegeneration, SceneRegenerationCoordinator, toSceneFrame,
  type ElementMesh, type SceneMeshSink, type SceneMeshUpdate, type SceneNodeRecord,
} from "../src/index.js";

const G = (n: string) => `0TeldraWall${n.padEnd(10, "X")}1`;
const A = G("A"), B = G("B"), C = G("C"), NEW = G("N");
const Y_UP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const node = (id: string, part = ""): SceneNodeRecord => ({ nodeKey: `ifc:${id}:body${part}`, canonicalId: `wall:${id}`, ifcGlobalId: id, kind: "building" });
const nodes = [A, B, C].map((id) => node(id));
/** Unit-ish triangle at (x,y,z); z=2 is the canonical height. */
const mesh = (id: string, x = 0, parts = 1): ElementMesh => ({ globalId: id, parts: Array.from({ length: parts }, () => ({
  positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 2]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]), color: [0.5, 0.5, 0.5, 1] as const })) });
const tess = (table: Record<string, ElementMesh | null>) => (ids: readonly string[]) => new Map(ids.map((id) => [id, table[id] ?? null]));

describe("planSceneRegeneration", () => {
  it("replaces only changed elements, keeps node keys and canonical identity, converts to the scene frame", () => {
    const requested: string[][] = [];
    const plan = planSceneRegeneration({ nodes, canonicalToScene: Y_UP, changedGlobalIds: [A, A],
      tessellate: (ids) => { requested.push([...ids]); return tess({ [A]: mesh(A, 3) })(ids); } });
    expect(requested).toEqual([[A]]);
    if (plan.kind !== "patch") throw new Error(plan.kind);
    expect(plan.update.replace).toHaveLength(1);
    expect(plan.update.add).toEqual([]);
    expect(plan.update.remove).toEqual([]);
    const element = plan.update.replace[0]!;
    expect(element).toMatchObject({ globalId: A, canonicalId: `wall:${A}`, previousNodeKeys: [`ifc:${A}:body`] });
    expect(element.parts[0]!.node).toEqual({ nodeKey: `ifc:${A}:body`, canonicalId: `wall:${A}`, ifcGlobalId: A, kind: "building", renderPart: "body" });
    // canonical (x, y, z) -> scene (x, z, -y); third vertex (3, 1, 2) -> (3, 2, -1)
    expect([...element.parts[0]!.positions.slice(6)]).toEqual([3, 2, -1]);
    expect([...element.parts[0]!.normals.slice(0, 3)]).toEqual([0, 1, 0]);
  });
  it("numbers multi-part elements like the exporter and flips winding for mirroring frames", () => {
    const plan = planSceneRegeneration({ nodes, canonicalToScene: Y_UP, changedGlobalIds: [B], tessellate: tess({ [B]: mesh(B, 0, 2) }) });
    if (plan.kind !== "patch") throw new Error(plan.kind);
    expect(plan.update.replace[0]!.parts.map((p) => p.node.nodeKey)).toEqual([`ifc:${B}:body:0`, `ifc:${B}:body:1`]);
    const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect([...toSceneFrame(B, mesh(B).parts[0]!, mirror).indices]).toEqual([0, 2, 1]);
  });
  it("adds new elements only with a resolvable canonical identity and removes deleted ones", () => {
    const base = { nodes, canonicalToScene: Y_UP, tessellate: tess({ [NEW]: mesh(NEW), [C]: null }) };
    expect(planSceneRegeneration({ ...base, changedGlobalIds: [NEW] })).toMatchObject({ kind: "rebuild", reason: "unresolved-identity" });
    const plan = planSceneRegeneration({ ...base, changedGlobalIds: [NEW, C], resolveCanonicalId: (id) => `wall:${id}` });
    expect(plan).toMatchObject({ kind: "patch", update: { replace: [], add: [{ globalId: NEW, canonicalId: `wall:${NEW}`, previousNodeKeys: [] }],
      remove: [{ globalId: C, canonicalId: `wall:${C}`, nodeKeys: [`ifc:${C}:body`] }] } });
  });
  it("tells the renderer which rendered element a new element should borrow its material from (duplicates)", () => {
    const base = { nodes, canonicalToScene: Y_UP, tessellate: tess({ [NEW]: mesh(NEW), [A]: mesh(A) }), resolveCanonicalId: (id: string) => `wall:${id}`,
      resolveMaterialSource: (id: string) => id === NEW ? A : undefined };
    const plan = planSceneRegeneration({ ...base, changedGlobalIds: [NEW, A] });
    if (plan.kind !== "patch") throw new Error(plan.kind);
    expect(plan.update.add[0]).toMatchObject({ globalId: NEW, materialSourceGlobalId: A });
    expect(plan.update.replace[0]!.materialSourceGlobalId).toBeUndefined(); // replaced elements keep their own material
  });
  it("is a noop for no ids or for unknown, already absent elements", () => {
    expect(planSceneRegeneration({ nodes, canonicalToScene: Y_UP, changedGlobalIds: [], tessellate: tess({}) })).toEqual({ kind: "noop" });
    expect(planSceneRegeneration({ nodes, canonicalToScene: Y_UP, changedGlobalIds: [NEW], tessellate: tess({}) })).toEqual({ kind: "noop" });
  });
  it.each([
    ["tessellator throws", () => { throw new Error("boom"); }, "tessellation-failed"],
    ["missing result", () => new Map(), "tessellation-failed"],
    ["no triangles", () => new Map([[A, { globalId: A, parts: [] }]]), "empty-geometry"],
    ["non-finite vertex", () => new Map([[A, { globalId: A, parts: [{ ...mesh(A).parts[0]!, positions: new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]) }] }]]), "invalid-geometry"],
    ["index out of range", () => new Map([[A, { globalId: A, parts: [{ ...mesh(A).parts[0]!, indices: new Uint32Array([0, 1, 9]) }] }]]), "invalid-geometry"],
  ])("falls back to a full rebuild: %s", (_name, tessellate, reason) => {
    expect(planSceneRegeneration({ nodes, canonicalToScene: Y_UP, changedGlobalIds: [A], tessellate })).toMatchObject({ kind: "rebuild", reason });
  });
  it("rebuilds for a singular frame or too many elements", () => {
    expect(planSceneRegeneration({ nodes, canonicalToScene: new Array(16).fill(0), changedGlobalIds: [A], tessellate: tess({ [A]: mesh(A) }) }))
      .toMatchObject({ kind: "rebuild", reason: "invalid-frame" });
    expect(planSceneRegeneration({ nodes, canonicalToScene: Y_UP, changedGlobalIds: [A, B], maxPatchElements: 1, tessellate: tess({}) }))
      .toMatchObject({ kind: "rebuild", reason: "too-many-elements" });
  });
});

describe("SceneRegenerationCoordinator revision consistency", () => {
  const sink = (fail = false) => {
    const applied: Array<{ update: SceneMeshUpdate; revision: number }> = [];
    const impl: SceneMeshSink = { applyUpdate(update, revision) {
      if (fail) return { ok: false, error: new Error("gpu lost") };
      applied.push({ update, revision }); return { ok: true };
    } };
    return { applied, impl };
  };
  const make = (s: SceneMeshSink, initialRevision = 0) => new SceneRegenerationCoordinator({
    nodes, canonicalToScene: Y_UP, initialRevision, sink: s, resolveCanonicalId: (id) => `wall:${id}` });
  const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

  it("applies a revision and exposes the revision the scene reflects", async () => {
    const s = sink(), c = make(s.impl);
    expect(c.reflectedRevision).toBe(0);
    const result = await c.request({ revision: 1, changedGlobalIds: [A], tessellate: tess({ [A]: mesh(A) }) });
    expect(result).toEqual({ status: "applied", revision: 1, elements: [A] });
    expect(c.reflectedRevision).toBe(1);
    expect(s.applied.map((a) => a.revision)).toEqual([1]);
  });
  it("discards requests for an already reflected or older revision", async () => {
    const s = sink(), c = make(s.impl, 5);
    expect(await c.request({ revision: 5, changedGlobalIds: [A], tessellate: tess({ [A]: mesh(A) }) })).toMatchObject({ status: "stale", reflectedRevision: 5 });
    expect(await c.request({ revision: 3, changedGlobalIds: [A], tessellate: tess({ [A]: mesh(A) }) })).toMatchObject({ status: "stale" });
    expect(s.applied).toEqual([]);
  });
  it("discards a stale async result and regenerates its ids from the newest snapshot (concurrent edits)", async () => {
    const s = sink(), c = make(s.impl);
    const slow = deferred<ReadonlyMap<string, ElementMesh | null>>();
    const first = c.request({ revision: 1, changedGlobalIds: [A], tessellate: () => slow.promise });
    const second = c.request({ revision: 2, changedGlobalIds: [B], tessellate: tess({ [A]: mesh(A, 9), [B]: mesh(B, 9) }) });
    slow.resolve(new Map([[A, mesh(A, 1)]]));
    expect(await first).toMatchObject({ status: "stale", revision: 1 });
    expect(await second).toMatchObject({ status: "applied", revision: 2 });
    expect(s.applied).toHaveLength(1);
    expect(s.applied[0]!.update.replace.map((e) => e.globalId).sort()).toEqual([A, B].sort()); // r1's id not lost
    expect(s.applied[0]!.update.replace[0]!.parts[0]!.positions[0]).toBe(9); // from revision-2 bytes
    expect(c.reflectedRevision).toBe(2);
    expect(c.pendingGlobalIds).toEqual([]);
  });
  it("tracks additions and deletions in its node view for later patches", async () => {
    const s = sink(), c = make(s.impl);
    await c.request({ revision: 1, changedGlobalIds: [NEW, C], tessellate: tess({ [NEW]: mesh(NEW), [C]: null }) });
    expect(c.nodes.map((n) => n.nodeKey).sort()).toEqual([`ifc:${A}:body`, `ifc:${B}:body`, `ifc:${NEW}:body`].sort());
    // undo: the added wall disappears, the deleted wall returns, regenerated from the restored bytes
    await c.request({ revision: 2, changedGlobalIds: [NEW, C], tessellate: tess({ [NEW]: null, [C]: mesh(C) }) });
    expect(s.applied[1]!.update).toMatchObject({ remove: [{ globalId: NEW }], add: [{ globalId: C }] });
    expect(c.nodes.map((n) => n.nodeKey).sort()).toEqual(nodes.map((n) => n.nodeKey).sort());
    expect(c.reflectedRevision).toBe(2);
  });
  it("retains the previous scene and revision when apply fails, surfaces the error, and retries the ids", async () => {
    const failing = sink(true), c = make(failing.impl);
    const result = await c.request({ revision: 1, changedGlobalIds: [A], tessellate: tess({ [A]: mesh(A) }) });
    expect(result).toMatchObject({ status: "failed", revision: 1 });
    expect((result as { error: Error }).error.message).toBe("gpu lost");
    expect(c.reflectedRevision).toBe(0);
    expect(c.pendingGlobalIds).toEqual([A]);
    expect(c.nodes).toEqual(nodes);
  });
  it("requests a rebuild without advancing the revision on tessellation failure, then adopts the rebuilt scene", async () => {
    const s = sink(), c = make(s.impl);
    const result = await c.request({ revision: 1, changedGlobalIds: [A], tessellate: () => { throw new Error("web-ifc died"); } });
    expect(result).toMatchObject({ status: "rebuild-required", reason: "tessellation-failed" });
    expect(c.reflectedRevision).toBe(0);
    expect(s.applied).toEqual([]);
    c.markRebuilt(1, [node(A), node(NEW)]);
    expect(c.reflectedRevision).toBe(1);
    expect(c.pendingGlobalIds).toEqual([]);
    expect(c.nodes).toHaveLength(2);
  });
});
