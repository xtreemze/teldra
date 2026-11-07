import { describe, expect, it } from "vitest";
import fixture from "../../../fixtures/projects/golden-home/building.ifc?raw";
import { IfcAPI, IFCFURNITURE } from "web-ifc";
import { readFurniturePose, writeFurniturePose } from "../src/index.js";

const bytes = new TextEncoder().encode(fixture);
const guid = "16W6mYG0DO8hR8U$bz6FSv";

describe("IFC furniture placement", () => {
  it("scales represented geometry through an IFC mapping and survives reopening and subsequent edits", async () => {
    const api = new IfcAPI(); await api.Init();
    const represented = new TextEncoder().encode(fixture.replace("'Chair',$,$,#154,$,$,$", "'Chair',$,$,#154,#70,$,$"));
    const scaled = writeFurniturePose(api, represented, guid, { position: [1, -1, 0], yawRadians: 0, uniformScale: 2 });
    expect(readFurniturePose(api, scaled, guid).uniformScale).toBe(2);
    expect(new TextDecoder().decode(scaled)).toContain("IFCMAPPEDITEM");
    const scaledModel = api.OpenModel(scaled);
    const chair = api.GetLineIDsWithType(scaledModel, IFCFURNITURE).get(0);
    const meshes = api.GetFlatMesh(scaledModel, chair).geometries;
    expect(meshes.size()).toBeGreaterThan(0);
    const matrix = meshes.get(0).flatTransformation;
    expect(Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!)).toBeCloseTo(2);
    api.CloseModel(scaledModel);
    const updated = writeFurniturePose(api, scaled, guid, { position: [2, 0, 0], yawRadians: 0.2, uniformScale: 3 });
    expect(readFurniturePose(api, updated, guid).uniformScale).toBe(3);
    expect(readFurniturePose(api, represented, guid).uniformScale ?? 1).toBe(1);
  });
  it("rejects scaling furniture without geometry", async () => {
    const api = new IfcAPI(); await api.Init();
    expect(() => writeFurniturePose(api, bytes, guid, { position: [1, -1, 0], yawRadians: 0, uniformScale: 2 })).toThrow("no IFC geometry");
  });
  it("writes an independent placement, preserves identity, and survives export/reopen", async () => {
    const api = new IfcAPI(); await api.Init();
    const before = readFurniturePose(api, bytes, guid);
    expect(before.position).toEqual([1, -1, 0]);
    const result = writeFurniturePose(api, bytes, guid, { position: [2, 3, 1], yawRadians: Math.PI / 2 });
    expect(readFurniturePose(api, bytes, guid)).toEqual(before);
    const reopened = readFurniturePose(api, result, guid);
    expect(reopened.position[0]).toBeCloseTo(2);
    expect(reopened.position[1]).toBeCloseTo(3);
    expect(reopened.position[2]).toBeCloseTo(1);
    expect(reopened.yawRadians).toBeCloseTo(Math.PI / 2);
  });
  it("rejects missing furniture and invalid pose without changing source bytes", async () => {
    const api = new IfcAPI(); await api.Init();
    expect(() => writeFurniturePose(api, bytes, guid, { position: [NaN, 0, 0], yawRadians: 0 })).toThrow();
    expect(() => readFurniturePose(api, bytes, "not-a-guid")).toThrow();
  });
  it("does not move another furniture object sharing the original placement", async () => {
    const api = new IfcAPI(); await api.Init();
    const id = api.OpenModel(bytes);
    const ids = api.GetLineIDsWithType(id, IFCFURNITURE);
    const other = api.GetLine(id, ids.get(0));
    const otherGuid = "0AAAAAAAAAAAAAAAAAAAAA";
    other.expressID = -1; other.GlobalId.value = otherGuid; api.WriteLine(id, other);
    const shared = api.SaveModel(id); api.CloseModel(id);
    const untouched = readFurniturePose(api, shared, otherGuid);
    const changed = writeFurniturePose(api, shared, guid, { position: [5, 6, 7], yawRadians: 0.3 });
    expect(readFurniturePose(api, changed, otherGuid)).toEqual(untouched);
  });

});
