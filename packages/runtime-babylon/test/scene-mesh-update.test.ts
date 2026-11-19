import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { planSceneRegeneration, SceneRegenerationCoordinator, type ElementMesh, type SceneNodeRecord } from "@teldra/projection";
import { applySceneMeshUpdate, type SceneMeshUpdateContext } from "../src/scene-mesh-update";
import { SceneLayers } from "../src/view-controls";
import type { TwinRenderIdentity } from "../src/identity";
import type { MeshBatch } from "../src/mesh-batching";

const G = (n: string) => `0TeldraWall${n.padEnd(10, "X")}1`;
const A = G("A"), B = G("B"), C = G("C"), NEW = G("N");
const Y_UP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const record = (id: string): SceneNodeRecord => ({ nodeKey: `ifc:${id}:body`, canonicalId: `wall:${id}`, ifcGlobalId: id, kind: "building", renderPart: "body" });
/** A canonical-frame quad (two triangles) spanning x..x+1 at height 2. */
const wall = (id: string, x: number): ElementMesh => ({ globalId: id, parts: [{
  positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x + 1, 0, 2, x, 0, 2]),
  normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]), color: [0.2, 0.4, 0.6, 1] }] });

let engine: NullEngine, scene: Scene, ctx: SceneMeshUpdateContext;
let materials: Record<string, StandardMaterial>;
const batchByPart = new Map<AbstractMesh, MeshBatch>();

beforeEach(() => {
  engine = new NullEngine(); scene = new Scene(engine);
  materials = {};
  const layers = new SceneLayers();
  ctx = { scene, layers, manifestByNodeKey: new Map(), identityByMesh: new WeakMap(), meshByNodeKey: new Map(),
    meshesByCanonicalId: new Map(), renderMeshes: [], physicalMeshes: [], batchByPart, sourceHiddenMeshes: new Set() };
  for (const id of [A, B, C]) {
    const mesh = CreateBox(`ifc:${id}:body`, {}, scene);
    const material = materials[id] = new StandardMaterial(`texture-${id}`, scene);
    mesh.material = material;
    mesh.metadata = { gltf: { extras: { teldra: { nodeKey: `ifc:${id}:body`, canonicalId: `wall:${id}`, ifcGlobalId: id }, teldraSourceLayer: { levelId: "L1", levelName: "Level 1" } } } };
    const identity: TwinRenderIdentity = { nodeKey: `ifc:${id}:body`, canonicalId: `wall:${id}`, ifcGlobalId: id };
    ctx.manifestByNodeKey.set(identity.nodeKey, identity); ctx.identityByMesh.set(mesh, identity);
    ctx.meshByNodeKey.set(identity.nodeKey, mesh); ctx.meshesByCanonicalId.set(identity.canonicalId, [mesh]);
    layers.add(mesh, identity.canonicalId, false);
    ctx.renderMeshes.push(mesh); ctx.physicalMeshes.push(mesh);
  }
  batchByPart.clear();
});
afterEach(() => { scene.dispose(); engine.dispose(); });

const nodes = [A, B, C].map(record);
const plan = (changed: string[], table: Record<string, ElementMesh | null>) => {
  const result = planSceneRegeneration({ nodes, canonicalToScene: Y_UP, changedGlobalIds: changed,
    tessellate: (ids) => new Map(ids.map((id) => [id, table[id] ?? null])), resolveCanonicalId: (id) => `wall:${id}` });
  if (result.kind !== "patch") throw new Error(result.kind);
  return result.update;
};
const snapshot = () => ({ meshes: scene.meshes.map((m) => m.uniqueId).sort(), keys: [...ctx.meshByNodeKey.keys()].sort(),
  layers: JSON.stringify(ctx.layers.list()), physical: ctx.physicalMeshes.map((m) => m.uniqueId) });

describe("applySceneMeshUpdate (Babylon adapter)", () => {
  it("replaces only the changed mesh: same node key and identity, new geometry in the scene frame, material preserved", () => {
    const untouched = [ctx.meshByNodeKey.get(`ifc:${B}:body`)!, ctx.meshByNodeKey.get(`ifc:${C}:body`)!];
    const old = ctx.meshByNodeKey.get(`ifc:${A}:body`)!;
    expect(applySceneMeshUpdate(ctx, plan([A], { [A]: wall(A, 5) }))).toEqual({ ok: true });
    const next = ctx.meshByNodeKey.get(`ifc:${A}:body`)!;
    expect(next).not.toBe(old);
    expect(old.isDisposed()).toBe(true);
    expect(ctx.meshByNodeKey.get(`ifc:${B}:body`)).toBe(untouched[0]);
    expect(ctx.meshByNodeKey.get(`ifc:${C}:body`)).toBe(untouched[1]);
    expect(untouched.every((m) => !m.isDisposed())).toBe(true);
    expect(ctx.identityByMesh.get(next)).toEqual({ nodeKey: `ifc:${A}:body`, canonicalId: `wall:${A}`, ifcGlobalId: A });
    expect(ctx.meshesByCanonicalId.get(`wall:${A}`)).toEqual([next]);
    expect(next.material).toBe(materials[A]); // texture/material of the replaced element survives
    expect(scene.materials).toContain(materials[A]!);
    expect(untouched[0]!.material).toBe(materials[B]);
    // canonical (x, y, z) -> scene (x, z, -y): quad top-right (6, 0, 2) -> (6, 2, -0)
    const positions = next.getVerticesData("position")!;
    expect([...positions.slice(6, 9)].map(Math.abs)).toEqual([6, 2, 0]);
    expect((next.metadata.gltf.extras.teldra)).toMatchObject({ nodeKey: `ifc:${A}:body`, ifcGlobalId: A });
    expect(next.metadata.gltf.extras.teldraSourceLayer).toEqual({ levelId: "L1", levelName: "Level 1" });
    expect(next.isEnabled() && next.isPickable).toBe(true);
    expect(ctx.layers.list().find((l) => l.id === "category:Walls")?.meshParts).toBe(3);
    expect(ctx.physicalMeshes).toHaveLength(3);
    expect(ctx.physicalMeshes).toContain(next);
  });
  it("adds a new element with a neutral IFC-coloured material and removes a deleted one (and its empty bookkeeping)", () => {
    const removed = ctx.meshByNodeKey.get(`ifc:${C}:body`)!;
    expect(applySceneMeshUpdate(ctx, plan([NEW, C], { [NEW]: wall(NEW, 1), [C]: null }))).toEqual({ ok: true });
    expect(removed.isDisposed()).toBe(true);
    expect(ctx.meshByNodeKey.has(`ifc:${C}:body`)).toBe(false);
    expect(ctx.meshesByCanonicalId.has(`wall:${C}`)).toBe(false);
    expect(ctx.manifestByNodeKey.has(`ifc:${C}:body`)).toBe(false);
    const added = ctx.meshByNodeKey.get(`ifc:${NEW}:body`)!;
    expect(ctx.identityByMesh.get(added)).toMatchObject({ canonicalId: `wall:${NEW}`, ifcGlobalId: NEW });
    expect(ctx.manifestByNodeKey.has(`ifc:${NEW}:body`)).toBe(true);
    expect((added.material as StandardMaterial).diffuseColor.b).toBeCloseTo(0.6);
    expect(ctx.physicalMeshes).toContain(added);
    expect(ctx.physicalMeshes).not.toContain(removed);
    expect(ctx.layers.list().find((l) => l.id === "category:Walls")?.meshParts).toBe(3);
  });
  it("is idempotent across repeated regeneration (undo/redo style churn keeps one mesh per node)", () => {
    for (const x of [1, 2, 3]) expect(applySceneMeshUpdate(ctx, plan([A], { [A]: wall(A, x) }))).toEqual({ ok: true });
    expect(ctx.meshesByCanonicalId.get(`wall:${A}`)).toHaveLength(1);
    expect(scene.meshes.filter((m) => m.name === `ifc:${A}:body` && !m.isDisposed())).toHaveLength(1);
    expect(ctx.physicalMeshes).toHaveLength(3);
  });
  it("leaves the previous scene exactly intact when staging fails (malformed data)", () => {
    const before = snapshot();
    const update = plan([A, B], { [A]: wall(A, 5), [B]: wall(B, 6) });
    const bad = { ...update, replace: [update.replace[0]!, { ...update.replace[1]!,
      parts: [{ ...update.replace[1]!.parts[0]!, indices: new Uint32Array([0, 1, 99]) }] }] };
    const result = applySceneMeshUpdate(ctx, bad);
    expect(result.ok).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(scene.meshes.every((m) => !m.isDisposed())).toBe(true);
    expect(ctx.meshByNodeKey.get(`ifc:${A}:body`)!.getVerticesData("position")!.length).toBe(24 * 3);
  });
  it("rejects merged-batch parts and duplicate keys without mutating anything", () => {
    const before = snapshot();
    batchByPart.set(ctx.meshByNodeKey.get(`ifc:${B}:body`)!, {} as MeshBatch);
    const batched = applySceneMeshUpdate(ctx, plan([A, B], { [A]: wall(A, 5), [B]: wall(B, 5) }));
    expect(batched).toMatchObject({ ok: false });
    expect((batched as { error: Error }).error.name).toBe("SceneMeshUpdateUnsupportedError");
    batchByPart.clear();
    const dup = plan([NEW], { [NEW]: wall(NEW, 1) });
    const clash = { ...dup, add: [{ ...dup.add[0]!, parts: [{ ...dup.add[0]!.parts[0]!, node: { ...dup.add[0]!.parts[0]!.node, nodeKey: `ifc:${A}:body` } }] }] };
    expect(applySceneMeshUpdate(ctx, clash)).toMatchObject({ ok: false });
    expect(snapshot()).toEqual(before);
  });
  it("works as the sink of a revision-aware coordinator: stale results never touch the scene; a failing sink keeps the old scene", async () => {
    const applied: number[] = [];
    let failNext = false;
    const coordinator = new SceneRegenerationCoordinator({ nodes, canonicalToScene: Y_UP, initialRevision: 0,
      resolveCanonicalId: (id) => `wall:${id}`,
      sink: { applyUpdate: (update, revision) => {
        if (failNext) return { ok: false, error: new Error("injected") };
        const result = applySceneMeshUpdate(ctx, update); if (result.ok) applied.push(revision); return result;
      } } });
    const tessellate = (x: number) => (ids: readonly string[]) => new Map(ids.map((id) => [id, wall(id, x)]));
    const slow = coordinator.request({ revision: 1, changedGlobalIds: [A], tessellate: async (ids) => { await Promise.resolve(); return tessellate(1)(ids); } });
    const fast = coordinator.request({ revision: 2, changedGlobalIds: [B], tessellate: tessellate(2) });
    expect((await slow).status).toBe("stale");
    expect((await fast).status).toBe("applied");
    expect(applied).toEqual([2]);
    expect(coordinator.reflectedRevision).toBe(2);
    const keep = snapshot();
    failNext = true;
    const failed = await coordinator.request({ revision: 3, changedGlobalIds: [C], tessellate: tessellate(3) });
    expect(failed).toMatchObject({ status: "failed" });
    expect(coordinator.reflectedRevision).toBe(2);
    expect(snapshot()).toEqual(keep);
    expect(ctx.meshByNodeKey.get(`ifc:${A}:body`)).toBeInstanceOf(Mesh);
  });
});
