import { describe, expect, it } from "vitest";
import raw from "../../../fixtures/projects/golden-home/building.ifc?raw";
import { IfcAPI } from "web-ifc";
import { readFurnitureGeometryScale, writeFurnitureGeometryScale } from "../src/index.js";

const guid = "16W6mYG0DO8hR8U$bz6FSv";
const otherGuid = "0AAAAAAAAAAAAAAAAAAAAA";
const code = new TextEncoder();

function mappedFixture(sharedDefinition = false) {
  const source = raw.replace(
    "#149=IFCFURNITURE('16W6mYG0DO8hR8U$bz6FSv',$,'Chair',$,$,#154,$,$,$);",
    "#149=IFCFURNITURE('16W6mYG0DO8hR8U$bz6FSv',$,'Chair',$,$,#154,#304,$,$);",
  );
  if (source === raw) throw new Error("Original furniture fixture changed.");
  const lines = [
    "#300=IFCREPRESENTATIONMAP(#10,#64);",
    "#301=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#7,1.,$);",
    "#302=IFCMAPPEDITEM(#300,#301);",
    "#303=IFCSHAPEREPRESENTATION(#12,'Body','MappedRepresentation',(#302));",
    "#304=IFCPRODUCTDEFINITIONSHAPE($,$,(#303));",
  ];
  if (sharedDefinition) lines.push(
    "#305=IFCFURNITURE('" + otherGuid + "',$,'Other chair',$,$,#154,#304,$,$);",
  );
  else lines.push(
    "#305=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#7,1.,$);",
    "#306=IFCMAPPEDITEM(#300,#305);",
    "#307=IFCSHAPEREPRESENTATION(#12,'Body','MappedRepresentation',(#306));",
    "#308=IFCPRODUCTDEFINITIONSHAPE($,$,(#307));",
    "#309=IFCFURNITURE('" + otherGuid + "',$,'Other chair',$,$,#154,#308,$,$);",
  );
  return code.encode(source.replace("\nENDSEC;\nEND-ISO-10303-21;", "\n" + lines.join("\n") + "\nENDSEC;\nEND-ISO-10303-21;"));
}

describe("IFC4 mapped-instance scaling", () => {
  it("rejects geometry-free furniture without altering source bytes", async () => {
    const api = new IfcAPI(); await api.Init();
    const bytes = code.encode(raw);
    expect(() => readFurnitureGeometryScale(api, bytes, guid)).toThrow(/representation/i);
    expect(() => writeFurnitureGeometryScale(api, bytes, guid, [2,2,2])).toThrow();
    expect(new TextDecoder().decode(bytes)).toBe(raw);
  });

  it("writes independent X/Y/Z scale without mutating shared source representation", async () => {
    const api = new IfcAPI(); await api.Init();
    const bytes = mappedFixture();
    expect(readFurnitureGeometryScale(api, bytes, guid)).toEqual([1,1,1]);
    expect(readFurnitureGeometryScale(api, bytes, otherGuid)).toEqual([1,1,1]);
    const result = writeFurnitureGeometryScale(api, bytes, guid, [1.25,2,0.5]);
    expect(readFurnitureGeometryScale(api, result, guid)).toEqual([1.25,2,0.5]);
    expect(readFurnitureGeometryScale(api, result, otherGuid)).toEqual([1,1,1]);
    expect(readFurnitureGeometryScale(api, bytes, guid)).toEqual([1,1,1]);
    const reopened = writeFurnitureGeometryScale(api, result, guid, [1,1,1]);
    expect(readFurnitureGeometryScale(api, reopened, guid)).toEqual([1,1,1]);
  });

  it("rejects product sharing and invalid factors before writing IFC", async () => {
    const api = new IfcAPI(); await api.Init();
    const bytes = mappedFixture(true);
    expect(() => readFurnitureGeometryScale(api, bytes, guid)).toThrow(/shared/i);
    const exclusive = mappedFixture();
    for (const scale of [[0,1,1], [-1,1,1], [NaN,1,1], [1,Infinity,1], [1,1,1001]] as const)
      expect(() => writeFurnitureGeometryScale(api, exclusive, guid, scale)).toThrow(/finite, positive/i);
  });
});
