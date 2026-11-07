import { describe, expect, it } from "vitest";
import raw from "../../../fixtures/projects/golden-home/building.ifc?raw";
import { IfcAPI } from "web-ifc";
import { readFurnitureGeometryScale, writeFurnitureGeometryScale, readFurnitureSourceDimensions } from "../src/index.js";

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
    expect(() => readFurnitureGeometryScale(api, bytes, guid)).toThrow(/IfcProductDefinitionShape/);
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


describe("immutable source-authored SH3D dimensions", () => {
  it("reads nominal width/depth/height from source IFC provenance", async () => {
    const api = new IfcAPI(); await api.Init();
    const bytes = code.encode(raw);
    expect(readFurnitureSourceDimensions(api, bytes, guid)).toEqual([0.5,0.5,1]);
    const represented = mappedFixture();
    const resized = writeFurnitureGeometryScale(api, represented, guid, [1.5,2,0.8]);
    expect(readFurnitureSourceDimensions(api, represented, guid)).toEqual([0.5,0.5,1]);
    expect(readFurnitureSourceDimensions(api, resized, guid)).toEqual([0.5,0.5,1]);
    expect(readFurnitureGeometryScale(api, resized, guid)).toEqual([1.5,2,0.8]);
  });

  it("does not invent nominal dimensions for non-SH3D provenance", async () => {
    const api = new IfcAPI(); await api.Init();
    const modified = raw.replace(
      "#157=IFCPROPERTYSINGLEVALUE('SourceSystem',$,IFCLABEL('Sweet Home 3D'),$);",
      "#157=IFCPROPERTYSINGLEVALUE('SourceSystem',$,IFCLABEL('Other importer'),$);",
    );
    expect(modified).not.toEqual(raw);
    expect(readFurnitureSourceDimensions(api, code.encode(modified), guid)).toBeNull();
  });

  it("rejects invalid and duplicated source sizes rather than presenting fabricated dimensions", async () => {
    const api = new IfcAPI(); await api.Init();
    const altered = raw.replace(
      "#164=IFCPROPERTYSINGLEVALUE('SourceWidthMetres',$,IFCREAL(0.5),$);",
      "#164=IFCPROPERTYSINGLEVALUE('SourceWidthMetres',$,IFCREAL(-0.5),$);",
    );
    expect(altered).not.toBe(raw);
    expect(() => readFurnitureSourceDimensions(api, code.encode(altered), guid))
      .toThrow(/SourceWidthMetres/);
    const duplicated = raw.replace(
      "(#157,#158,#159,#160,#161,#162,#163,#164,#165,#166)",
      "(#157,#158,#159,#160,#161,#162,#163,#164,#164,#165,#166)",
    );
    expect(duplicated).not.toBe(raw);
    expect(() => readFurnitureSourceDimensions(api, code.encode(duplicated), guid))
      .toThrow(/Duplicate source provenance property/);
    const shared = raw.replace(
      "(#149),#155);",
      "(#149,#167),#155);",
    );
    expect(shared).not.toBe(raw);
    expect(() => readFurnitureSourceDimensions(api, code.encode(shared), guid))
      .toThrow(/Shared SH3D source provenance/);
  });
});
