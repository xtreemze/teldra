import { describe, expect, it } from "vitest";
import raw from "../../../fixtures/projects/golden-home/building.ifc?raw";
import { IfcAPI } from "web-ifc";
import { readFurnitureGeometryScale, writeFurnitureGeometryScale, readFurnitureSourceDimensions, readFurnitureTessellationSignature } from "../src/index.js";

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


describe("source IFC triangulation integrity for browser GLB rebake", () => {
  function tessellationFixture() {
    const sample = new TextDecoder().decode(mappedFixture());
    const mapped = sample.replace(
      "#300=IFCREPRESENTATIONMAP(#10,#64);",
      "#300=IFCREPRESENTATIONMAP(#10,#312);",
    );
    if (mapped === sample) throw new Error("IFC mapping fixture changed.");
    const triangles = [
      "#310=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));",
      "#311=IFCTRIANGULATEDFACESET(#310,$,$,((1,2,3)),$);",
      "#312=IFCSHAPEREPRESENTATION(#12,'Body','Tessellation',(#311));",
    ].join("\n");
    return code.encode(mapped.replace("\nENDSEC;\nEND-ISO-10303-21;",
      "\n" + triangles + "\nENDSEC;\nEND-ISO-10303-21;"));
  }
  it("preserves source mesh identity through canonical MappingTarget scale and placement", async () => {
    const api = new IfcAPI(); await api.Init();
    const source = tessellationFixture();
    const signature = readFurnitureTessellationSignature(api,source,guid);
    expect(signature).toContain("coordinates");
    const resized = writeFurnitureGeometryScale(api,source,guid,[2,0.75,1.5]);
    expect(readFurnitureTessellationSignature(api,resized,guid)).toBe(signature);
  });
  it("rejects edited source vertex coordinates or face connectivity", async () => {
    const api = new IfcAPI(); await api.Init();
    const source = tessellationFixture();
    const baseline=readFurnitureTessellationSignature(api,source,guid);
    const vertexChange=new TextDecoder().decode(source).replace(
      "((0.,0.,0.),(1.,0.,0.),(0.,1.,0.))",
      "((0.,0.,0.),(1.25,0.,0.),(0.,1.,0.))",
    );
    expect(vertexChange).not.toEqual(new TextDecoder().decode(source));
    expect(readFurnitureTessellationSignature(api,code.encode(vertexChange),guid)).not.toBe(baseline);
    const edgeChange=new TextDecoder().decode(source).replace(
      "IFCTRIANGULATEDFACESET(#310,$,$,((1,2,3)),$)",
      "IFCTRIANGULATEDFACESET(#310,$,$,((1,3,2)),$)",
    );
    expect(readFurnitureTessellationSignature(api,code.encode(edgeChange),guid)).not.toBe(baseline);
  });
  it("does not invent source mesh signatures for geometry-free furniture", async () => {
    const api = new IfcAPI(); await api.Init();
    expect(()=>readFurnitureTessellationSignature(api,code.encode(raw),guid)).toThrow();
  });
});
