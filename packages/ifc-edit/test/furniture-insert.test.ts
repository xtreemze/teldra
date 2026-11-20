import { beforeAll, describe, expect, it } from "vitest";
import raw from "../../../fixtures/projects/golden-home/building.ifc?raw";
import catalogJson from "../../../fixtures/furniture-catalog/synthetic-boxes.catalog.json" with { type: "json" };
import { IfcAPI, IFCFURNITURE, IFCFURNITURETYPE, IFCREPRESENTATIONMAP, IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELDEFINESBYTYPE, IFCROOT } from "web-ifc";
import { parseFurnitureCatalog, type FurnitureCatalogItem } from "@teldra/furniture-catalog";
import { IfcFurnitureEditor } from "@teldra/application";
import {
  FurnitureInsertError, insertFurniture, readFurnitureCatalogProvenance, readFurnitureGeometryScale, readFurniturePose,
  readFurnitureSourceDimensions, tessellateElements, writeFurnitureGeometryScale, writeFurniturePose,
} from "../src/index.js";

const STOREY = "3alYBHMR1G5AaThtWNzo_l"; // Ground Floor in the golden home
const NEW_A = "0TeldraCatalogChairA01", NEW_B = "0TeldraCatalogChairB01", NEW_C = "0TeldraCatalogShelfC01", NEW_D = "0TeldraCatalogPictD001";
const catalog = parseFurnitureCatalog(catalogJson);
const item = (id: string): FurnitureCatalogItem => catalog.items.find((i) => i.id === id)!;
const source = new TextEncoder().encode(raw);
const provenance = { catalogId: catalog.id, catalogVersion: catalog.version };
const request = (ifcGlobalId: string, itemId: string, extra: Record<string, unknown> = {}) => ({
  ifcGlobalId, storeyGlobalId: STOREY, item: item(itemId), ...provenance,
  pose: { position: [2.5, -2, 0] as const, yawRadians: Math.PI / 2 }, ...extra,
});
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
let api: IfcAPI;
beforeAll(async () => { api = new IfcAPI(); await api.Init(); });

const count = (bytes: Uint8Array, type: number) => {
  const id = api.OpenModel(bytes);
  try { return api.GetLineIDsWithType(id, type).size(); } finally { api.CloseModel(id); }
};
const allGlobalIds = (bytes: Uint8Array) => {
  const id = api.OpenModel(bytes);
  try {
    const out: string[] = []; const ids = api.GetLineIDsWithType(id, IFCROOT, true);
    for (let i = 0; i < ids.size(); i++) out.push((api.GetLine(id, ids.get(i)) as any).GlobalId.value);
    return out;
  } finally { api.CloseModel(id); }
};
const bounds = (bytes: Uint8Array, guid: string) => {
  const mesh = tessellateElements(api, bytes, [guid]).get(guid)!;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const part of mesh.parts) for (let i = 0; i < part.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, part.positions[i]!); max[i % 3] = Math.max(max[i % 3]!, part.positions[i]!);
  }
  return { min, max, size: max.map((v, i) => v - min[i]!) };
};

describe("insertFurniture: catalog item -> canonical IfcFurniture", () => {
  it("creates a new GlobalId, typed, mapped, contained in the storey, at the requested world pose", () => {
    const result = insertFurniture(api, source, request(NEW_A, "box-chair", { name: "Dining chair" }));
    expect(allGlobalIds(result)).toContain(NEW_A);
    // original identities survive untouched
    for (const guid of allGlobalIds(source)) expect(allGlobalIds(result)).toContain(guid);
    expect(count(result, IFCFURNITURE)).toBe(count(source, IFCFURNITURE) + 1);

    const pose = readFurniturePose(api, result, NEW_A);
    expect(pose.position[0]).toBeCloseTo(2.5); expect(pose.position[1]).toBeCloseTo(-2); expect(pose.position[2]).toBeCloseTo(0);
    expect(pose.yawRadians).toBeCloseTo(Math.PI / 2);
    // mapped per-instance geometry the existing editors understand
    expect(readFurnitureGeometryScale(api, result, NEW_A)).toEqual([1, 1, 1]);
    // not mistaken for SH3D-sourced nominal dimensions
    expect(readFurnitureSourceDimensions(api, result, NEW_A)).toBeNull();

    const id = api.OpenModel(result);
    try {
      const element = [...Array(api.GetLineIDsWithType(id, IFCFURNITURE).size()).keys()]
        .map((i) => api.GetLine(id, api.GetLineIDsWithType(id, IFCFURNITURE).get(i)) as any).find((l) => l.GlobalId.value === NEW_A);
      expect(element.Name.value).toBe("Dining chair");
      const containment = api.GetLineIDsWithType(id, IFCRELCONTAINEDINSPATIALSTRUCTURE);
      const rels = [...Array(containment.size()).keys()].map((i) => api.GetLine(id, containment.get(i)) as any);
      expect(rels.filter((r) => r.RelatedElements.some((e: any) => e.value === element.expressID))).toHaveLength(1);
      const storeyRel = rels.find((r) => r.RelatedElements.some((e: any) => e.value === element.expressID))!;
      expect((api.GetLine(id, storeyRel.RelatingStructure.value) as any).GlobalId.value).toBe(STOREY);
      // typed by an IfcFurnitureType carrying the catalog predefined type and a representation map
      const types = api.GetLineIDsWithType(id, IFCFURNITURETYPE);
      expect(types.size()).toBe(1);
      const type = api.GetLine(id, types.get(0)) as any;
      expect(type.PredefinedType.value).toBe("CHAIR");
      expect(type.Name.value).toBe("Box chair");
      expect(type.RepresentationMaps).toHaveLength(1);
      const byType = api.GetLineIDsWithType(id, IFCRELDEFINESBYTYPE);
      const rel = [...Array(byType.size()).keys()].map((i) => api.GetLine(id, byType.get(i)) as any)
        .find((r) => r.RelatingType.value === type.expressID)!;
      expect(rel.RelatedObjects.map((o: any) => o.value)).toEqual([element.expressID]);
    } finally { api.CloseModel(id); }
  });

  it("preserves nominal dimensions in the written geometry (box, local origin at bottom centre)", () => {
    const result = insertFurniture(api, source, request(NEW_A, "box-chair", { pose: { position: [4, -1, 0], yawRadians: 0 } }));
    const { size, min, max } = bounds(result, NEW_A);
    expect(size[0]).toBeCloseTo(0.5, 5); expect(size[1]).toBeCloseTo(0.45, 5); expect(size[2]).toBeCloseTo(0.9, 5);
    expect(min[2]).toBeCloseTo(0, 5); expect(max[2]).toBeCloseTo(0.9, 5);
    expect((min[0]! + max[0]!) / 2).toBeCloseTo(4, 5); expect((min[1]! + max[1]!) / 2).toBeCloseTo(-1, 5);
  });

  it("writes an extrusion footprint and honours yaw in the world frame", () => {
    const result = insertFurniture(api, source, request(NEW_C, "l-shelf", { pose: { position: [1, -3, 0], yawRadians: Math.PI / 2 } }));
    const { size } = bounds(result, NEW_C);
    // 1.0 x 0.5 footprint rotated a quarter turn occupies 0.5 x 1.0 in world X/Y
    expect(size[0]).toBeCloseTo(0.5, 5); expect(size[1]).toBeCloseTo(1, 5); expect(size[2]).toBeCloseTo(1.8, 5);
  });

  it("places wall-mounted items at the requested elevation", () => {
    const result = insertFurniture(api, source, request(NEW_D, "wall-picture", { pose: { position: [0.3, -0.05, 1.4], yawRadians: 0 } }));
    expect(readFurniturePose(api, result, NEW_D).position[2]).toBeCloseTo(1.4);
    expect(bounds(result, NEW_D).min[2]).toBeCloseTo(1.4, 5);
  });

  it("composes with a storey that is not at the world origin", () => {
    const raised = raw.replace("#25=IFCCARTESIANPOINT((0.,0.,0.));", "#25=IFCCARTESIANPOINT((10.,20.,3.));");
    expect(raised).not.toBe(raw);
    const result = insertFurniture(api, new TextEncoder().encode(raised), request(NEW_A, "box-chair", { pose: { position: [12, 21, 3.5], yawRadians: 0.3 } }));
    const pose = readFurniturePose(api, result, NEW_A);
    expect(pose.position[0]).toBeCloseTo(12); expect(pose.position[1]).toBeCloseTo(21); expect(pose.position[2]).toBeCloseTo(3.5);
    expect(pose.yawRadians).toBeCloseTo(0.3);
  });

  it("records catalog provenance, licence and nominal dimensions on the shared type", () => {
    const licensed = { ...item("box-chair"), licence: { spdx: "CC-BY-4.0", author: "A. Author", attribution: "Chair by A. Author (CC BY 4.0)", sourceUrl: "https://example.org/chair", redistribution: "bundle" as const } };
    const result = insertFurniture(api, source, request(NEW_A, "box-chair", { item: licensed }));
    expect(readFurnitureCatalogProvenance(api, result, NEW_A)).toEqual({
      catalogId: "teldra-synthetic-boxes", catalogVersion: "1.0.0", itemId: "box-chair",
      licence: { spdx: "CC-BY-4.0", author: "A. Author", attribution: "Chair by A. Author (CC BY 4.0)", sourceUrl: "https://example.org/chair", redistribution: "bundle" },
      mount: { type: "floor" }, nominalDimensions: [0.5, 0.45, 0.9],
    });
    expect(readFurnitureCatalogProvenance(api, source, "16W6mYG0DO8hR8U$bz6FSv")).toBeNull();
  });

  it("writes bSDD classification references and an associated material", () => {
    const result = insertFurniture(api, source, request(NEW_A, "box-chair"));
    const text = new TextDecoder().decode(result);
    expect(text).toMatch(/IFCCLASSIFICATION\(\$,\$,\$,'bSDD'/);
    expect(text).toMatch(/IFCCLASSIFICATIONREFERENCE\('https:\/\/identifier\.buildingsmart\.org[^']*','IfcFurniture\.CHAIR','Chair'/);
    expect(text).toMatch(/IFCRELASSOCIATESCLASSIFICATION\(/);
    expect(text).toMatch(/IFCMATERIAL\('Painted wood'/);
    expect(text).toMatch(/IFCRELASSOCIATESMATERIAL\(/);
  });

  it("shares one type and representation map across occurrences; scaling one leaves the other alone", () => {
    const once = insertFurniture(api, source, request(NEW_A, "box-chair"));
    const twice = insertFurniture(api, once, request(NEW_B, "box-chair", { pose: { position: [3, -1, 0], yawRadians: 0 } }));
    expect(count(twice, IFCFURNITURETYPE)).toBe(1);
    expect(count(twice, IFCREPRESENTATIONMAP)).toBe(count(once, IFCREPRESENTATIONMAP));
    expect(allGlobalIds(twice).filter((g) => g === NEW_A || g === NEW_B)).toHaveLength(2);
    const scaled = writeFurnitureGeometryScale(api, twice, NEW_B, [2, 1, 1]);
    expect(readFurnitureGeometryScale(api, scaled, NEW_A)).toEqual([1, 1, 1]);
    expect(bounds(scaled, NEW_B).size[0]).toBeCloseTo(1, 5);
    expect(bounds(scaled, NEW_A).size[0]).toBeCloseTo(0.45, 5); // A is yawed a quarter turn: world X spans its depth
    // a different catalog item gets its own type
    expect(count(insertFurniture(api, twice, request(NEW_C, "l-shelf")), IFCFURNITURETYPE)).toBe(2);
  });

  it("inserted furniture is editable like imported furniture (move) and keeps its identity", () => {
    const result = insertFurniture(api, source, request(NEW_A, "box-chair"));
    const moved = writeFurniturePose(api, result, NEW_A, { position: [1, 1, 0], yawRadians: 0 });
    expect(readFurniturePose(api, moved, NEW_A).position[0]).toBeCloseTo(1);
    expect(allGlobalIds(moved)).toContain(NEW_A);
  });

  it("is deterministic and leaves the input bytes untouched", () => {
    const before = source.slice();
    const a = insertFurniture(api, source, request(NEW_A, "box-chair"));
    const b = insertFurniture(api, source, request(NEW_A, "box-chair"));
    expect(sameBytes(a, b)).toBe(true);
    expect(sameBytes(source, before)).toBe(true);
  });

  it("refuses invalid input explicitly without changing anything", () => {
    const code = (fn: () => unknown) => { try { fn(); } catch (error) { return error instanceof FurnitureInsertError ? error.code : `other:${String(error)}`; } return "no-error"; };
    expect(code(() => insertFurniture(api, source, request("short", "box-chair")))).toBe("invalid-global-id");
    expect(code(() => insertFurniture(api, source, request("16W6mYG0DO8hR8U$bz6FSv", "box-chair")))).toBe("duplicate-global-id");
    expect(code(() => insertFurniture(api, source, request(NEW_A, "box-chair", { storeyGlobalId: "0TeldraNoSuchStorey001" })))).toBe("storey-not-found");
    expect(code(() => insertFurniture(api, source, request(NEW_A, "box-chair", { pose: { position: [NaN, 0, 0], yawRadians: 0 } })))).toBe("invalid-pose");
    expect(code(() => insertFurniture(api, source, request(NEW_A, "box-chair", { item: { ...item("box-chair"), id: "Bad Id" } })))).toBe("invalid-item");
    expect(code(() => insertFurniture(api, source, request(NEW_A, "box-chair", { name: "   " })))).toBe("invalid-name");
    const noBody = raw.replace("'Body','Model'", "'Other','Model'");
    expect(code(() => insertFurniture(api, new TextEncoder().encode(noBody), request(NEW_A, "box-chair")))).toBe("body-context-missing");
  });

  it("a conflicting type under the same catalog key (different nominal size) is refused", () => {
    const once = insertFurniture(api, source, request(NEW_A, "box-chair"));
    const bigger = { ...item("box-chair"), dimensions: { ...item("box-chair").dimensions, width: 0.8 } };
    expect(() => insertFurniture(api, once, request(NEW_B, "box-chair", { item: bigger }))).toThrow(/different nominal dimensions/);
  });
});

describe("IfcFurnitureEditor.insert: reversible canonical insertion", () => {
  const adapter = () => ({
    read: (bytes: Uint8Array, guid: string) => readFurniturePose(api, bytes, guid),
    write: (bytes: Uint8Array, guid: string, pose: { position: readonly [number, number, number]; yawRadians: number }) => writeFurniturePose(api, bytes, guid, pose),
    insert: (bytes: Uint8Array, input: Parameters<typeof insertFurniture>[2]) => insertFurniture(api, bytes, input),
  });

  it("inserts through command history, records the affected GlobalId, and undoes to byte-identical IFC", () => {
    const editor = new IfcFurnitureEditor(source, adapter());
    editor.insert(request(NEW_A, "box-chair"));
    expect(editor.lastAffectedGlobalIds).toEqual([NEW_A]);
    expect(editor.read(NEW_A).position[0]).toBeCloseTo(2.5);
    expect(editor.history.canUndo).toBe(true);
    const inserted = editor.bytes;

    expect(editor.undo()).toBe(true);
    expect(sameBytes(editor.bytes, source)).toBe(true);
    expect(editor.lastAffectedGlobalIds).toEqual([NEW_A]); // regeneration removes the instance

    expect(editor.redo()).toBe(true);
    expect(sameBytes(editor.bytes, inserted)).toBe(true);
    expect(editor.lastAffectedGlobalIds).toEqual([NEW_A]);
  });

  it("an invalid insert leaves bytes and history untouched", () => {
    const editor = new IfcFurnitureEditor(source, adapter());
    expect(() => editor.insert(request(NEW_A, "box-chair", { pose: { position: [NaN, 0, 0], yawRadians: 0 } }))).toThrow();
    expect(() => editor.insert(request("16W6mYG0DO8hR8U$bz6FSv", "box-chair"))).toThrow(/already|duplicate/i);
    expect(sameBytes(editor.bytes, source)).toBe(true);
    expect(editor.history.canUndo).toBe(false);
  });

  it("an adapter without insert support refuses explicitly", () => {
    const { read, write } = adapter();
    expect(() => new IfcFurnitureEditor(source, { read, write }).insert(request(NEW_A, "box-chair"))).toThrow(/cannot insert/i);
  });

  it("insert then move then undo twice returns to the original bytes", () => {
    const editor = new IfcFurnitureEditor(source, adapter());
    editor.insert(request(NEW_A, "box-chair"));
    editor.place(NEW_A, { position: [1, 1, 0], yawRadians: 0 });
    editor.undo(); editor.undo();
    expect(sameBytes(editor.bytes, source)).toBe(true);
  });
});
