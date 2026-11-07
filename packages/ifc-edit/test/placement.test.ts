import { describe, expect, it } from "vitest";
import fixture from "../../../fixtures/projects/golden-home/building.ifc?raw";
import { IfcAPI, IFCFURNITURE } from "web-ifc";
import { readFurniturePose, writeFurniturePose } from "../src/index.js";

const bytes = new TextEncoder().encode(fixture);
const guid = "16W6mYG0DO8hR8U$bz6FSv";

describe("IFC furniture placement", () => {
  it("rejects moving a proxy that fills a hosted opening",async()=>{
    const api=new IfcAPI();await api.Init();
    const hosted=fixture.replace("IFCFURNITURE(","IFCBUILDINGELEMENTPROXY(").replace("ENDSEC;\nEND-ISO-10303-21;", "#99990=IFCOPENINGELEMENT('1Ku0EdV$X7qxV8_lKszoFq',$,'Opening',$,$,#154,$,$,.OPENING.);\n#99991=IFCRELFILLSELEMENT('31lGOMRir8fONp6JFdxBYF',$,$,$,#99990,#149);\nENDSEC;\nEND-ISO-10303-21;");
    expect(()=>writeFurniturePose(api,new TextEncoder().encode(hosted),guid,{position:[2,3,0],yawRadians:0})).toThrow("host-aware");
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
