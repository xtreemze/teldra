import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import type { TwinProject } from "@teldra/domain";
import {
  IfcFurnitureEditor, TwinEditor, FurnitureRemovalVetoError, assertFurnitureRemovable,
  nextFurnitureCopyId, ifcGlobalIdFromBytes, type IfcFurnitureAdapter, type FurnitureWorldPose,
} from "../src/index.js";

// A tiny JSON "IFC" proves the application contract without web-ifc: bytes are the only state.
interface Model { elements: Record<string, { pose: FurnitureWorldPose; name: string }> }
const encode = (m: Model) => new TextEncoder().encode(JSON.stringify(m));
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as Model;
const pose = (x: number): FurnitureWorldPose => ({ position: [x, 0, 0], yawRadians: 0 });
const adapter: IfcFurnitureAdapter = {
  read: (bytes, id) => { const e = decode(bytes).elements[id]; if (!e) throw new Error("missing " + id); return e.pose; },
  write: (bytes, id, p) => { const m = decode(bytes); m.elements[id]!.pose = p; return encode(m); },
  duplicate: (bytes, id, newId, options) => {
    const m = decode(bytes); const src = m.elements[id]; if (!src) throw new Error("missing " + id);
    if (m.elements[newId]) throw new Error("exists " + newId);
    const o = options?.offset ?? [0, 0, 0];
    m.elements[newId] = { name: options?.name ?? src.name, pose: { position: [src.pose.position[0] + o[0], src.pose.position[1] + o[1], src.pose.position[2] + o[2]], yawRadians: src.pose.yawRadians } };
    return encode(m);
  },
  remove: (bytes, id) => { const m = decode(bytes); if (!m.elements[id]) throw new Error("missing " + id); delete m.elements[id]; return encode(m); },
};
const start = () => encode({ elements: { A: { name: "Chair", pose: pose(1) } } });
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe("IfcFurnitureEditor lifecycle commands", () => {
  it("duplicates through a reversible command; undo is byte-identical and redo reproduces the copy", () => {
    const editor = new IfcFurnitureEditor(start(), adapter); const before = editor.bytes;
    editor.duplicate("A", "B", { offset: [0.5, 0, 0], name: "Chair copy" });
    expect(editor.read("B")).toEqual({ position: [1.5, 0, 0], yawRadians: 0 });
    expect(editor.read("A")).toEqual(pose(1));
    const after = editor.bytes;
    expect(editor.undo()).toBe(true);
    expect(same(editor.bytes, before)).toBe(true);
    expect(() => editor.read("B")).toThrow();
    expect(editor.redo()).toBe(true);
    expect(same(editor.bytes, after)).toBe(true);
  });

  it("removes through a reversible command; undo restores byte-identical bytes", () => {
    const editor = new IfcFurnitureEditor(start(), adapter); const before = editor.bytes;
    editor.remove("A");
    expect(() => editor.read("A")).toThrow();
    expect(editor.undo()).toBe(true);
    expect(same(editor.bytes, before)).toBe(true);
    expect(editor.redo()).toBe(true);
    expect(() => editor.read("A")).toThrow();
  });

  it("leaves bytes and history untouched when the adapter refuses", () => {
    const editor = new IfcFurnitureEditor(start(), adapter); const before = editor.bytes;
    expect(() => editor.duplicate("missing", "B")).toThrow();
    expect(() => editor.remove("missing")).toThrow();
    expect(same(editor.bytes, before)).toBe(true);
    expect(editor.history.canUndo).toBe(false);
  });

  it("reports an explicit error when the IFC adapter has no lifecycle support", () => {
    const { duplicate: _d, remove: _r, ...basic } = adapter;
    const editor = new IfcFurnitureEditor(start(), basic);
    expect(() => editor.duplicate("A", "B")).toThrow(/duplicat/i);
    expect(() => editor.remove("A")).toThrow(/remov/i);
  });

  it("records affected GlobalIds for duplicate, remove, undo and redo so scenes can add/remove meshes", () => {
    const editor = new IfcFurnitureEditor(start(), adapter);
    editor.duplicate("A", "B");
    expect(editor.lastAffectedGlobalIds).toEqual(["B"]);
    editor.remove("A");
    expect(editor.lastAffectedGlobalIds).toEqual(["A"]);
    editor.undo(); expect(editor.lastAffectedGlobalIds).toEqual(["A"]);
    editor.undo(); expect(editor.lastAffectedGlobalIds).toEqual(["B"]);
    editor.redo(); expect(editor.lastAffectedGlobalIds).toEqual(["B"]);
    expect(() => editor.remove("missing")).toThrow();
    expect(editor.lastAffectedGlobalIds).toEqual(["B"]);
  });

  it("composes with pose edits in one linear history", () => {
    const editor = new IfcFurnitureEditor(start(), adapter);
    editor.duplicate("A", "B"); editor.place("B", pose(9)); editor.remove("A");
    expect(editor.undo()).toBe(true); expect(editor.undo()).toBe(true);
    expect(editor.read("B")).toEqual(pose(1));
    expect(editor.undo()).toBe(true);
    expect(() => editor.read("B")).toThrow();
  });
});

describe("twin building-reference lifecycle", () => {
  const twin = (): TwinProject => {
    const t = structuredClone(goldenTwin) as TwinProject;
    t.building.refs.push({ id: "chair", ifcGlobalId: "16W6mYG0DO8hR8U$bz6FSv", kind: "furniture", name: "Chair" });
    return t;
  };

  it("adds a building ref with a new canonical id and undoes/redoes it", () => {
    const editor = new TwinEditor(twin()); const before = structuredClone(editor.twin);
    editor.addBuildingRef({ id: "chair-copy", ifcGlobalId: "2gEfmKcdn6c9fX3LLRJBkX", kind: "furniture", name: "Chair copy" });
    expect(editor.twin.building.refs.map(r => r.id)).toContain("chair-copy");
    expect(editor.undo()).not.toBeNull();
    expect(editor.twin).toEqual(before);
    expect(editor.redo()).not.toBeNull();
    expect(editor.twin.building.refs.map(r => r.id)).toContain("chair-copy");
  });

  it("rejects an added ref that reuses a canonical id or an IFC GlobalId", () => {
    const editor = new TwinEditor(twin());
    expect(() => editor.addBuildingRef({ id: "chair", ifcGlobalId: "2gEfmKcdn6c9fX3LLRJBkX", kind: "furniture" })).toThrow();
    expect(() => editor.addBuildingRef({ id: "chair-copy", ifcGlobalId: "16W6mYG0DO8hR8U$bz6FSv", kind: "furniture" })).toThrow();
  });

  it("removes an unbound furniture ref and restores it on undo", () => {
    const editor = new TwinEditor(twin()); const before = structuredClone(editor.twin);
    editor.removeBuildingRef("chair");
    expect(editor.twin.building.refs.some(r => r.id === "chair")).toBe(false);
    editor.undo();
    expect(editor.twin).toEqual(before);
  });

  it("vetoes removal when a twin device (and its external bindings) references the element, naming them", () => {
    const editor = new TwinEditor(twin()); const before = structuredClone(editor.twin);
    const lamp = "fixture:living-room-floor-lamp";
    expect(() => editor.removeBuildingRef(lamp)).toThrow(FurnitureRemovalVetoError);
    try { assertFurnitureRemovable(editor.twin, lamp); expect.unreachable(); }
    catch (error) {
      const veto = error as FurnitureRemovalVetoError;
      expect(veto.code).toBe("device-bound");
      expect(veto.deviceIds).toEqual(["device:living-room-floor-lamp"]);
      expect(veto.bindingIds).toEqual(["binding:living-room-floor-lamp:home-assistant"]);
      expect(veto.message).toContain("device:living-room-floor-lamp");
    }
    expect(editor.twin).toEqual(before);
    expect(editor.history.canUndo).toBe(false);
  });

  it("refuses to remove a non-furniture building reference (space) and an unknown id", () => {
    const editor = new TwinEditor(twin());
    expect(() => editor.removeBuildingRef("space:living-room")).toThrow(/furniture/);
    expect(() => editor.removeBuildingRef("nope")).toThrow(/unknown/i);
  });
});

describe("lifecycle identity helpers", () => {
  it("allocates a stable, unique canonical copy id", () => {
    expect(nextFurnitureCopyId("chair", ["chair"])).toBe("chair-copy");
    expect(nextFurnitureCopyId("chair", ["chair", "chair-copy"])).toBe("chair-copy-2");
    expect(nextFurnitureCopyId("chair-copy", ["chair", "chair-copy"])).toBe("chair-copy-2");
    expect(nextFurnitureCopyId("chair", ["chair", "chair-copy", "chair-copy-2"])).toBe("chair-copy-3");
  });
  it("encodes 16 random bytes as a valid compressed IFC GlobalId", () => {
    const id = ifcGlobalIdFromBytes(new Uint8Array(16).fill(255));
    expect(id).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
    expect(ifcGlobalIdFromBytes(new Uint8Array(16))).toBe("0".repeat(22));
    expect(() => ifcGlobalIdFromBytes(new Uint8Array(15))).toThrow();
  });
});
