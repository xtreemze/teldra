import { describe, expect, it } from "vitest";
import { AffectedElementLog } from "../src/affected-elements.js";
import { IfcWallEditor, type IfcWallAdapter } from "../src/ifc-wall-editor.js";
import { IfcFurnitureEditor, type IfcFurnitureAdapter } from "../src/ifc-furniture-editor.js";

const A = "0TeldraWallAAAAAAAAAA1", B = "0TeldraWallBBBBBBBBBB1";
const g = (ex: number) => ({ start: [0, 0] as const, end: [ex, 0] as const, thickness: 0.2, height: 2.5, elevation: 0 });

describe("AffectedElementLog", () => {
  it("follows apply/undo/redo and drops redo history on a new apply", () => {
    const log = new AffectedElementLog();
    log.recordApply([A, A, B]);
    expect(log.last).toEqual([A, B]);
    log.recordApply([B]);
    log.recordUndo(); expect(log.last).toEqual([B]);
    log.recordUndo(); expect(log.last).toEqual([A, B]);
    log.recordUndo(); expect(log.last).toEqual([A, B]); // nothing left to undo
    log.recordRedo(); expect(log.last).toEqual([A, B]);
    log.recordRedo(); expect(log.last).toEqual([B]);
    log.recordUndo(); log.recordApply([A]);
    log.recordRedo(); expect(log.last).toEqual([A]);
  });
});

describe("editors expose affected GlobalIds", () => {
  it("wall editor: apply -> requested and connected ids; undo reuses them; failures change nothing", () => {
    const adapter: IfcWallAdapter = {
      read: () => ({ ...g(1), connections: [] }),
      plan: (_b, op) => op.kind === "update"
        ? [{ globalId: op.globalId, kind: "updated", cause: "requested", before: g(1), after: g(2) }, { globalId: B, kind: "updated", cause: "connected", before: g(1), after: g(2) }]
        : [],
      apply: (bytes) => new Uint8Array([...bytes, 1]),
    };
    const editor = new IfcWallEditor(new Uint8Array([0]), adapter);
    expect(editor.lastAffectedGlobalIds).toEqual([]);
    editor.apply({ kind: "update", globalId: A, geometry: g(2) });
    expect(editor.lastAffectedGlobalIds).toEqual([A, B]);
    expect(editor.history.revision).toBe(1);
    editor.undo();
    expect(editor.lastAffectedGlobalIds).toEqual([A, B]);
    expect(editor.history.revision).toBe(2); // revision is monotonic across undo
    expect(() => editor.apply({ kind: "update", globalId: A, geometry: { ...g(2), thickness: 0 } })).toThrow();
    expect(editor.lastAffectedGlobalIds).toEqual([A, B]);
  });
  it("furniture editor: scale/place record the GlobalId and undo/redo replay it", () => {
    const adapter: IfcFurnitureAdapter = {
      read: () => ({ position: [0, 0, 0], yawRadians: 0 }),
      write: (b) => b.slice(), writeScale: (b) => b.slice(),
    };
    const editor = new IfcFurnitureEditor(new Uint8Array([0]), adapter);
    editor.place(A, { position: [1, 0, 0], yawRadians: 0 });
    expect(editor.lastAffectedGlobalIds).toEqual([A]);
    editor.scale(B, [1, 1, 2]);
    expect(editor.lastAffectedGlobalIds).toEqual([B]);
    editor.undo();
    expect(editor.lastAffectedGlobalIds).toEqual([B]);
    editor.undo();
    expect(editor.lastAffectedGlobalIds).toEqual([A]);
    editor.redo();
    expect(editor.lastAffectedGlobalIds).toEqual([A]);
  });
});
