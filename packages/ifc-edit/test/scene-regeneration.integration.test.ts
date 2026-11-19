import { beforeAll, describe, expect, it } from "vitest";
import fixture from "../../../fixtures/ifc/connected-walls/building.ifc?raw";
import { IfcAPI } from "web-ifc";
import { IfcWallEditor } from "@teldra/application";
import { planSceneRegeneration, type SceneNodeRecord } from "@teldra/projection";
import { createElementTessellator, createIfcWallAdapter, tessellateElements } from "../src/index.js";

const A = "0TeldraWallAAAAAAAAAA1", B = "0TeldraWallBBBBBBBBBB1", C = "0TeldraWallCCCCCCCCCC1", D = "0TeldraWallDDDDDDDDDD1";
const NEW = "0TeldraNewWallAAAAAAA1", STOREY = "0TeldraStoreyAAAAAAAA1";
const bytes = new TextEncoder().encode(fixture);
// Canonical Z-up -> glTF Y-up, identical to the Python exporter's CANONICAL_TO_GLTF.
const CANONICAL_TO_GLTF = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const geom = (sx: number, sy: number, ex: number, ey: number) => ({ start: [sx, sy] as const, end: [ex, ey] as const, thickness: 0.2, height: 2.5, elevation: 0 });
const nodes: SceneNodeRecord[] = [A, B, C, D].map((id) => ({ nodeKey: `ifc:${id}:body`, canonicalId: `wall:${id}`, ifcGlobalId: id, kind: "building" as const, renderPart: "body" }));
let api: IfcAPI;
let adapter: ReturnType<typeof createIfcWallAdapter>;
beforeAll(async () => { api = new IfcAPI(); await api.Init(); adapter = createIfcWallAdapter(api); });

const bounds = (positions: Float32Array) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) { min[i % 3] = Math.min(min[i % 3]!, positions[i]!); max[i % 3] = Math.max(max[i % 3]!, positions[i]!); }
  return { min, max };
};

describe("web-ifc read-side tessellation of connected-walls", () => {
  it("returns canonical-frame (metre, Z-up) triangles by GlobalId and null for unknown ids", () => {
    const result = tessellateElements(api, bytes, [A, "0TeldraMissingAAAAAAA1"]);
    expect(result.get("0TeldraMissingAAAAAAA1")).toBeNull();
    const wall = result.get(A)!;
    expect(wall.globalId).toBe(A);
    expect(wall.parts.length).toBeGreaterThan(0);
    const all = wall.parts.flatMap((part) => [...part.positions]);
    const { min, max } = bounds(new Float32Array(all));
    expect(max[2]! - min[2]!).toBeCloseTo(2.5, 3); // height along canonical Z
    expect(max[0]! - min[0]!).toBeGreaterThan(3.5); // length along X
    for (const part of wall.parts) {
      expect(part.indices.length % 3).toBe(0);
      expect(part.normals.length).toBe(part.positions.length);
    }
  });
  it("does not mutate the IFC bytes", () => {
    const copy = bytes.slice();
    tessellateElements(api, copy, [A, B, C]);
    expect([...copy]).toEqual([...bytes]);
  });
});

describe("scene regeneration for IfcWallEditor results", () => {
  it("re-tessellates only the changed (requested + connected) walls with stable identity in the scene frame", () => {
    const editor = new IfcWallEditor(bytes, adapter);
    const result = editor.apply({ kind: "update", globalId: A, geometry: geom(0, 0, 4, 1) });
    const changed = result.changes.map((change) => change.globalId);
    expect(changed).toEqual([A, B]);
    const requested: string[][] = [];
    const tessellate = createElementTessellator(api, editor.bytes);
    const plan = planSceneRegeneration({
      nodes, canonicalToScene: CANONICAL_TO_GLTF, changedGlobalIds: changed,
      tessellate: (ids) => { requested.push([...ids]); return tessellate(ids); },
    });
    expect(requested).toEqual([[A, B]]);
    if (plan.kind !== "patch") throw new Error("expected patch, got " + JSON.stringify(plan));
    expect(plan.update.replace.map((e) => e.globalId)).toEqual([A, B]);
    expect(plan.update.add).toEqual([]);
    expect(plan.update.remove).toEqual([]);
    const a = plan.update.replace[0]!;
    expect(a.canonicalId).toBe(`wall:${A}`);
    expect(a.parts.map((p) => p.node.nodeKey)).toEqual(a.previousNodeKeys);
    // Scene frame is Y-up: wall height 2.5 along scene Y, plan Y=1 end appears at scene -Z.
    const { min, max } = bounds(new Float32Array(a.parts.flatMap((p) => [...p.positions])));
    expect(max[1]! - min[1]!).toBeCloseTo(2.5, 3);
    expect(min[2]!).toBeLessThan(-0.9);
  });
  it("undo yields geometry equal to the original tessellation (derived scene follows canonical bytes)", () => {
    const editor = new IfcWallEditor(bytes, adapter);
    const before = tessellateElements(api, bytes, [A]).get(A)!;
    editor.apply({ kind: "update", globalId: A, geometry: geom(0, 0, 4, 1) });
    editor.undo();
    const after = tessellateElements(api, editor.bytes, [A]).get(A)!;
    expect(after.parts.map((p) => [...p.positions])).toEqual(before.parts.map((p) => [...p.positions]));
  });
  it("adds a created wall when a canonical id is supplied and removes it again", () => {
    const editor = new IfcWallEditor(bytes, adapter);
    editor.apply({ kind: "create", globalId: NEW, storeyGlobalId: STOREY, name: "New", geometry: geom(0, 8, 5, 8) });
    const added = planSceneRegeneration({
      nodes, canonicalToScene: CANONICAL_TO_GLTF, changedGlobalIds: [NEW],
      tessellate: createElementTessellator(api, editor.bytes), resolveCanonicalId: (id) => `wall:${id}`,
    });
    expect(added).toMatchObject({ kind: "patch", update: { add: [{ globalId: NEW, canonicalId: `wall:${NEW}` }] } });
    const unresolved = planSceneRegeneration({
      nodes, canonicalToScene: CANONICAL_TO_GLTF, changedGlobalIds: [NEW], tessellate: createElementTessellator(api, editor.bytes),
    });
    expect(unresolved).toMatchObject({ kind: "rebuild", reason: "unresolved-identity" });
    editor.undo();
    const withNew = [...nodes, { nodeKey: `ifc:${NEW}:body`, canonicalId: `wall:${NEW}`, ifcGlobalId: NEW, kind: "building" as const }];
    const removed = planSceneRegeneration({
      nodes: withNew, canonicalToScene: CANONICAL_TO_GLTF, changedGlobalIds: [NEW], tessellate: createElementTessellator(api, editor.bytes),
    });
    expect(removed).toMatchObject({ kind: "patch", update: { remove: [{ globalId: NEW, nodeKeys: [`ifc:${NEW}:body`] }] } });
  });
  it("falls back to a full rebuild when web-ifc cannot read the bytes", () => {
    const plan = planSceneRegeneration({
      nodes, canonicalToScene: CANONICAL_TO_GLTF, changedGlobalIds: [C],
      tessellate: createElementTessellator(api, new TextEncoder().encode("not an ifc file")),
    });
    // web-ifc either throws (rebuild) or yields no such product (removal); it must never invent geometry.
    expect(plan.kind === "rebuild" || (plan.kind === "patch" && plan.update.remove.length === 1)).toBe(true);
  });
});
