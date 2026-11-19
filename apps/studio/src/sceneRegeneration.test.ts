import { beforeAll, describe, expect, it } from "vitest";
import fixture from "../../../fixtures/ifc/connected-walls/building.ifc?raw";
import { IfcAPI } from "web-ifc";
import { IfcWallEditor } from "@teldra/application";
import { createIfcWallAdapter } from "@teldra/ifc-edit";
import type { SceneMeshSink, SceneMeshUpdate } from "@teldra/projection";
import type { TeldraSceneManifest } from "@teldra/scene-manifest";
import { createSceneRegeneration } from "./sceneRegeneration";

const A = "0TeldraWallAAAAAAAAAA1", B = "0TeldraWallBBBBBBBBBB1", C = "0TeldraWallCCCCCCCCCC1", D = "0TeldraWallDDDDDDDDDD1";
const bytes = new TextEncoder().encode(fixture);
const geom = (ex: number, ey: number) => ({ start: [0, 0] as const, end: [ex, ey] as const, thickness: 0.2, height: 2.5, elevation: 0 });
const manifest = { schemaVersion: "0.1.0", coordinateSystem: { unit: "metre", handedness: "right", upAxis: "Z" },
  source: { buildingPath: "building.ifc", buildingSha256: "0".repeat(64) },
  scene: { assetPath: "scene.glb", assetSha256: "0".repeat(64), format: "glb", canonicalToScene: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] },
  nodes: [A, B, C, D].map((id) => ({ nodeKey: `ifc:${id}:body`, canonicalId: `wall:${id}`, ifcGlobalId: id, kind: "building" as const })) } as TeldraSceneManifest;
let api: IfcAPI;
beforeAll(async () => { api = new IfcAPI(); await api.Init(); });
const harness = (fail = false) => {
  const applied: Array<{ revision: number; update: SceneMeshUpdate }> = [];
  const sink: SceneMeshSink = { applyUpdate: (update, revision) => fail ? { ok: false, error: new Error("viewport lost") } : (applied.push({ revision, update }), { ok: true }) };
  const editor = new IfcWallEditor(bytes, createIfcWallAdapter(api));
  return { applied, editor, regeneration: createSceneRegeneration(sink, manifest, api, editor.history.revision) };
};
const xs = (update: SceneMeshUpdate, id: string) => [...update.replace.find((e) => e.globalId === id)!.parts[0]!.positions];

describe("Studio scene regeneration hook (one call per edit)", () => {
  it("regenerates only the edited and connected walls and reports the reflected revision", async () => {
    const { applied, editor, regeneration } = harness();
    editor.apply({ kind: "update", globalId: A, geometry: geom(4, 1) });
    expect(await regeneration.regenerate(editor)).toMatchObject({ status: "applied", revision: 1 });
    expect(regeneration.reflectedRevision).toBe(1);
    expect(applied[0]!.update.replace.map((e) => e.globalId)).toEqual([A, B]);
    expect(applied[0]!.update.replace.every((e) => e.canonicalId === `wall:${e.globalId}`)).toBe(true);
  });
  it("undo regenerates from the restored bytes; redo from the re-applied bytes", async () => {
    const { applied, editor, regeneration } = harness();
    editor.apply({ kind: "update", globalId: A, geometry: geom(4, 1) });
    await regeneration.regenerate(editor);
    editor.undo();
    expect(await regeneration.regenerate(editor)).toMatchObject({ status: "applied", revision: 2 });
    editor.redo();
    await regeneration.regenerate(editor);
    expect(editor.history.revision).toBe(3);
    const [edited, undone, redone] = applied.map((a) => xs(a.update, A));
    expect(undone).not.toEqual(edited);
    expect(redone).toEqual(edited);
  });
  it("concurrent edits: the superseded request is dropped and nothing is lost", async () => {
    const { applied, editor, regeneration } = harness();
    editor.apply({ kind: "update", globalId: A, geometry: geom(4, 1) });
    const first = regeneration.regenerate(editor);
    editor.apply({ kind: "update", globalId: C, geometry: { ...geom(12, 1), start: [10, 1] } });
    const second = regeneration.regenerate(editor);
    expect((await first).status).toBe("stale");
    expect((await second).status).toBe("applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.update.replace.map((e) => e.globalId).sort()).toEqual([A, B, C].sort());
    expect(regeneration.reflectedRevision).toBe(2);
  });
  it("a failing viewport keeps the previous revision and surfaces the error", async () => {
    const { editor, regeneration } = harness(true);
    editor.apply({ kind: "update", globalId: A, geometry: geom(4, 1) });
    const result = await regeneration.regenerate(editor);
    expect(result).toMatchObject({ status: "failed", revision: 1 });
    expect((result as { error: Error }).error.message).toBe("viewport lost");
    expect(regeneration.reflectedRevision).toBe(0);
    expect(regeneration.coordinator.pendingGlobalIds).toEqual([A, B]);
  });
});
