import { describe, expect, it } from "vitest";
import { encodeStoredZip, openTeldraArchive, readScenePlacementOverrides, replaceTeldraBuilding, sha256Bytes } from "../src/archive.js";
import twin from "../../../fixtures/projects/golden-home/twin.json";
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe("building scene reconciliation", () => {
  it("binds a furniture delta to original scene, current IFC and GLB hashes", async () => {
    const building = new Uint8Array([1, 2]), glb = new Uint8Array([3, 4]);
    const modifiedTwin = structuredClone(twin);
    modifiedTwin.building.refs.push({ id: "chair", ifcGlobalId: "16W6mYG0DO8hR8U$bz6FSv", kind: "furniture", name: "Chair" } as never);
    const twinBytes = encode(modifiedTwin);
    const sourceHash = await sha256Bytes(building), assetHash = await sha256Bytes(glb);
    const manifest = { formatVersion: "0.1.0", building: { path: "building.ifc", sha256: sourceHash }, twin: { path: "twin.json", sha256: await sha256Bytes(twinBytes) }, derived: [] };
    const archive = await openTeldraArchive(encodeStoredZip([{ path: "project.json", bytes: encode(manifest) }, { path: "building.ifc", bytes: building }, { path: "twin.json", bytes: twinBytes }, { path: "scene.glb", bytes: glb }]));
    const scene = { source: { buildingPath: "building.ifc", buildingSha256: sourceHash }, scene: { assetPath: "scene.glb", assetSha256: assetHash }, nodes: [{ canonicalId: "chair", ifcGlobalId: "16W6mYG0DO8hR8U$bz6FSv" }] };
    expect(await readScenePlacementOverrides(archive, scene)).toBeNull();
    const placement = { canonicalId: "chair", ifcGlobalId: "16W6mYG0DO8hR8U$bz6FSv", matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 0, 1] };
    const saved = await replaceTeldraBuilding(archive, new Uint8Array([5]), scene, [placement]);
    expect((await readScenePlacementOverrides(saved.archive, scene))?.placements).toEqual([placement]);
    await expect(readScenePlacementOverrides(saved.archive, { ...scene, scene: { ...scene.scene, assetSha256: "0".repeat(64) } })).rejects.toThrow();
    await expect(replaceTeldraBuilding(archive, new Uint8Array([5]), scene, [{ ...placement, matrix: [2, ...placement.matrix.slice(1)] }])).rejects.toThrow("rigid");
    await expect(replaceTeldraBuilding(archive, new Uint8Array([5]), scene, [{ ...placement, canonicalId: "unknown" }])).rejects.toThrow("identity");
  });
});
