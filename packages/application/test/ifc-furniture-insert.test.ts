import { describe, expect, it } from "vitest";
import catalogJson from "../../../fixtures/furniture-catalog/synthetic-boxes.catalog.json" with { type: "json" };
import { parseFurnitureCatalog } from "@teldra/furniture-catalog";
import { IfcFurnitureEditor, type FurnitureInsertRequest, type FurnitureWorldPose } from "../src/ifc-furniture-editor.js";

const catalog = parseFurnitureCatalog(catalogJson);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as { elements: Record<string, FurnitureWorldPose> };
const empty = encode({ elements: {} });
const adapter = {
  read: (bytes: Uint8Array, guid: string) => decode(bytes).elements[guid]!,
  write: (bytes: Uint8Array, guid: string, pose: FurnitureWorldPose) => encode({ elements: { ...decode(bytes).elements, [guid]: pose } }),
  insert: (bytes: Uint8Array, request: FurnitureInsertRequest) => {
    const state = decode(bytes);
    if (state.elements[request.ifcGlobalId]) throw new Error("GlobalId already exists");
    return encode({ elements: { ...state.elements, [request.ifcGlobalId]: request.pose } });
  },
};
const request = (extra: Partial<FurnitureInsertRequest> = {}): FurnitureInsertRequest => ({
  ifcGlobalId: "0TeldraCatalogChairA01", storeyGlobalId: "3alYBHMR1G5AaThtWNzo_l", catalogId: catalog.id, catalogVersion: catalog.version,
  item: catalog.items[0]!, pose: { position: [1, 2, 0], yawRadians: 0.5 }, ...extra,
});

describe("IfcFurnitureEditor.insert (application command)", () => {
  it("applies, records the new GlobalId for regeneration, and undoes/redoes byte-identically", () => {
    const editor = new IfcFurnitureEditor(empty, adapter);
    editor.insert(request());
    expect(editor.read("0TeldraCatalogChairA01")).toEqual({ position: [1, 2, 0], yawRadians: 0.5 });
    expect(editor.lastAffectedGlobalIds).toEqual(["0TeldraCatalogChairA01"]);
    const inserted = editor.bytes;
    expect(editor.undo()).toBe(true);
    expect([...editor.bytes]).toEqual([...empty]);
    expect(editor.lastAffectedGlobalIds).toEqual(["0TeldraCatalogChairA01"]);
    expect(editor.redo()).toBe(true);
    expect([...editor.bytes]).toEqual([...inserted]);
  });

  it("validates before touching the adapter or history", () => {
    const editor = new IfcFurnitureEditor(empty, adapter);
    expect(() => editor.insert(request({ ifcGlobalId: "bad" }))).toThrow(/GlobalIds/);
    expect(() => editor.insert(request({ storeyGlobalId: "bad" }))).toThrow(/GlobalIds/);
    expect(() => editor.insert(request({ pose: { position: [0, Infinity, 0], yawRadians: 0 } }))).toThrow(/finite/);
    expect(() => editor.insert(request({ item: { ...catalog.items[0]!, dimensions: { ...catalog.items[0]!.dimensions, width: -1 } } }))).toThrow(/valid catalog item/);
    expect(editor.history.canUndo).toBe(false);
  });

  it("surfaces the adapter's own refusal and leaves history untouched", () => {
    const editor = new IfcFurnitureEditor(empty, adapter);
    editor.insert(request());
    expect(() => editor.insert(request())).toThrow("GlobalId already exists");
    editor.undo();
    expect(editor.history.canUndo).toBe(false);
    expect([...editor.bytes]).toEqual([...empty]);
  });

  it("refuses when the adapter has no insert support", () => {
    const { read, write } = adapter;
    expect(() => new IfcFurnitureEditor(empty, { read, write }).insert(request())).toThrow(/cannot insert/);
  });
});
