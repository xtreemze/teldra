import { beforeAll, describe, expect, it } from "vitest";
import fixture from "../../../fixtures/ifc/connected-walls/building.ifc?raw";
import { IfcAPI } from "web-ifc";
import { IfcWallEditor, type IfcWallAdapter } from "@teldra/application";
import { createIfcWallAdapter } from "../src/index.js";

const A = "0TeldraWallAAAAAAAAAA1", B = "0TeldraWallBBBBBBBBBB1", C = "0TeldraWallCCCCCCCCCC1", D = "0TeldraWallDDDDDDDDDD1";
const STOREY = "0TeldraStoreyAAAAAAAA1", NEW = "0TeldraNewWallAAAAAAA1";
const bytes = new TextEncoder().encode(fixture);
const geom = (sx: number, sy: number, ex: number, ey: number) => ({ start: [sx, sy] as const, end: [ex, ey] as const, thickness: 0.2, height: 2.5, elevation: 0 });
let adapter: IfcWallAdapter;
beforeAll(async () => { const api = new IfcAPI(); await api.Init(); adapter = createIfcWallAdapter(api); });

describe("IfcWallEditor over the real IFC wall writer", () => {
  it("moves a connected endpoint; undo restores byte-identical IFC and redo reapplies", () => {
    const editor = new IfcWallEditor(bytes, adapter);
    const preview = editor.preview({ kind: "update", globalId: A, geometry: geom(0, 0, 4, 1) });
    expect(preview.changes.map((c) => c.globalId)).toEqual([A, B]);
    expect([...editor.bytes]).toEqual([...bytes]);
    editor.apply({ kind: "update", globalId: A, geometry: geom(0, 0, 4, 1) });
    expect(editor.read(B).start[1]).toBeCloseTo(1);
    const edited = [...editor.bytes];
    expect(edited).not.toEqual([...bytes]);
    expect(editor.undo()).toBe(true);
    expect([...editor.bytes]).toEqual([...bytes]);
    expect(editor.redo()).toBe(true);
    expect([...editor.bytes]).toEqual(edited);
  });
  it("rejects unsupported edits with no change to bytes or history", () => {
    const editor = new IfcWallEditor(bytes, adapter);
    expect(() => editor.apply({ kind: "update", globalId: D, geometry: geom(0, 5, 3, 6) })).toThrow(/opening/);
    expect(() => editor.apply({ kind: "update", globalId: A, geometry: geom(0, 0, 0, 0) })).toThrow(/length/);
    expect(() => editor.apply({ kind: "remove", globalId: A })).toThrow(/relationship/);
    expect([...editor.bytes]).toEqual([...bytes]);
    expect(editor.history).toMatchObject({ revision: 0, canUndo: false });
  });
  it("batches create + update + remove as one atomic undo unit", () => {
    const editor = new IfcWallEditor(bytes, adapter);
    editor.apply([
      { kind: "create", globalId: NEW, storeyGlobalId: STOREY, name: "New", geometry: geom(0, 8, 5, 8) },
      { kind: "update", globalId: C, geometry: geom(10, 1, 12, 1) },
      { kind: "remove", globalId: NEW },
    ]);
    expect(editor.history.undoDepth).toBe(1);
    expect(editor.read(C).start[1]).toBeCloseTo(1);
    editor.undo();
    expect([...editor.bytes]).toEqual([...bytes]);
  });
  it("rolls back a batch whose later operation fails", () => {
    const editor = new IfcWallEditor(bytes, adapter);
    expect(() => editor.apply([
      { kind: "update", globalId: C, geometry: geom(10, 1, 12, 1) },
      { kind: "update", globalId: B, geometry: { ...geom(4, 0, 4, 3), thickness: 0 } },
    ])).toThrow();
    expect([...editor.bytes]).toEqual([...bytes]);
    expect(editor.history.canUndo).toBe(false);
  });
});
