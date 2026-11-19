import { describe, expect, it, vi } from "vitest";
import {
  IfcWallEditError, IfcWallEditor, type IfcWallAdapter, type IfcWallChange, type IfcWallGeometry, type IfcWallOperation,
} from "../src/ifc-wall-editor.js";

const A = "0TeldraWallAAAAAAAAAA1", B = "0TeldraWallBBBBBBBBBB1", NEW = "0TeldraNewWallAAAAAAA1", STOREY = "0TeldraStoreyAAAAAAAA1";
type Store = Record<string, IfcWallGeometry>;
const g = (sx: number, sy: number, ex: number, ey: number): IfcWallGeometry => ({ start: [sx, sy], end: [ex, ey], thickness: 0.2, height: 2.5, elevation: 0 });
const initial: Store = { [A]: g(0, 0, 4, 0), [B]: g(4, 0, 4, 3) };
const encode = (s: Store) => new TextEncoder().encode(JSON.stringify(s));
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as Store;

/** Fake adapter: A.end is joined to B.start. Mirrors the real adapter's contract, not its IFC internals. */
function makeAdapter() {
  const plan = vi.fn((bytes: Uint8Array, op: IfcWallOperation): IfcWallChange[] => {
    const s = decode(bytes);
    if (op.kind === "create") {
      if (s[op.globalId]) throw new Error("duplicate");
      return [{ globalId: op.globalId, kind: "created", cause: "requested", before: null, after: op.geometry }];
    }
    const before = s[op.globalId];
    if (!before) throw new Error("missing wall");
    if (op.kind === "remove") return [{ globalId: op.globalId, kind: "removed", cause: "requested", before, after: null }];
    const changes: IfcWallChange[] = [{ globalId: op.globalId, kind: "updated", cause: "requested", before, after: op.geometry }];
    if (op.globalId === A && s[B]) changes.push({ globalId: B, kind: "updated", cause: "connected", before: s[B], after: { ...s[B], start: op.geometry.end } });
    return changes;
  });
  const apply = vi.fn((bytes: Uint8Array, op: IfcWallOperation) => {
    const s = decode(bytes);
    for (const c of plan(bytes, op)) { if (c.after) s[c.globalId] = c.after; else delete s[c.globalId]; }
    return encode(s);
  });
  const adapter: IfcWallAdapter = {
    read: (bytes, guid) => ({ ...decode(bytes)[guid]!, connections: [] }),
    plan, apply,
  };
  return { adapter, plan, apply };
}

describe("IfcWallEditor", () => {
  it("previews without mutating bytes or history", () => {
    const { adapter } = makeAdapter();
    const editor = new IfcWallEditor(encode(initial), adapter);
    const before = [...editor.bytes], revision = editor.history.revision;
    const preview = editor.preview({ kind: "update", globalId: A, geometry: g(0, 0, 4, 1) });
    expect(preview.changes.map((c) => [c.globalId, c.cause])).toEqual([[A, "requested"], [B, "connected"]]);
    expect([...editor.bytes]).toEqual(before);
    expect(editor.history.revision).toBe(revision);
    expect(editor.history.canUndo).toBe(false);
  });
  it("applies, then undo restores byte-identical bytes and redo reapplies", () => {
    const editor = new IfcWallEditor(encode(initial), makeAdapter().adapter);
    const original = [...editor.bytes];
    const result = editor.apply({ kind: "update", globalId: A, geometry: g(0, 0, 4, 1) });
    expect(result.changes).toHaveLength(2);
    expect(editor.read(B).start).toEqual([4, 1]);
    const edited = [...editor.bytes];
    expect(editor.undo()).toBe(true);
    expect([...editor.bytes]).toEqual(original);
    expect(editor.redo()).toBe(true);
    expect([...editor.bytes]).toEqual(edited);
  });
  it("rejects invalid geometry and ids with explicit codes before touching the adapter", () => {
    const { adapter, plan, apply } = makeAdapter();
    const editor = new IfcWallEditor(encode(initial), adapter);
    const code = (op: IfcWallOperation) => { try { editor.apply(op); } catch (e) { return (e as IfcWallEditError).code; } return "none"; };
    expect(code({ kind: "update", globalId: A, geometry: g(0, 0, 0, 0) })).toBe("invalid-geometry");
    expect(code({ kind: "update", globalId: A, geometry: { ...g(0, 0, 1, 0), thickness: -1 } })).toBe("invalid-geometry");
    expect(code({ kind: "update", globalId: A, geometry: g(NaN, 0, 1, 0) })).toBe("invalid-geometry");
    expect(code({ kind: "update", globalId: "bad", geometry: g(0, 0, 1, 0) })).toBe("invalid-global-id");
    expect(code({ kind: "create", globalId: NEW, storeyGlobalId: STOREY, name: "  ", geometry: g(0, 0, 1, 0) })).toBe("invalid-name");
    expect(plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(editor.history.revision).toBe(0);
  });
  it("leaves bytes and history unchanged when the adapter refuses", () => {
    const editor = new IfcWallEditor(encode(initial), makeAdapter().adapter);
    const before = [...editor.bytes];
    expect(() => editor.apply({ kind: "update", globalId: "0TeldraNoSuchWallAAAA1", geometry: g(0, 0, 1, 0) })).toThrow();
    expect([...editor.bytes]).toEqual(before);
    expect(editor.history).toMatchObject({ revision: 0, canUndo: false });
  });
  it("creates and removes walls as undoable operations", () => {
    const editor = new IfcWallEditor(encode(initial), makeAdapter().adapter);
    const original = [...editor.bytes];
    editor.apply({ kind: "create", globalId: NEW, storeyGlobalId: STOREY, name: "New", geometry: g(0, 8, 5, 8) });
    expect(Object.keys(decode(editor.bytes))).toContain(NEW);
    editor.apply({ kind: "remove", globalId: NEW });
    expect(Object.keys(decode(editor.bytes))).not.toContain(NEW);
    editor.undo(); expect(Object.keys(decode(editor.bytes))).toContain(NEW);
    editor.undo(); expect([...editor.bytes]).toEqual(original);
  });
  it("treats a batch as one atomic undo unit and rolls the batch back on failure", () => {
    const editor = new IfcWallEditor(encode(initial), makeAdapter().adapter);
    const original = [...editor.bytes];
    editor.apply([
      { kind: "update", globalId: A, geometry: g(0, 0, 4, 1) },
      { kind: "create", globalId: NEW, storeyGlobalId: STOREY, name: "New", geometry: g(0, 8, 5, 8) },
    ]);
    expect(editor.history.undoDepth).toBe(1);
    editor.undo();
    expect([...editor.bytes]).toEqual(original);
    expect(() => editor.apply([
      { kind: "update", globalId: A, geometry: g(0, 0, 4, 2) },
      { kind: "remove", globalId: "0TeldraNoSuchWallAAAA1" },
    ])).toThrow();
    expect([...editor.bytes]).toEqual(original);
    expect(editor.history.revision).toBe(2);
  });
  it("does not let callers mutate editor state through returned bytes", () => {
    const editor = new IfcWallEditor(encode(initial), makeAdapter().adapter);
    const view = editor.bytes; view.fill(0);
    expect(decode(editor.bytes)[A]).toBeDefined();
  });
});
