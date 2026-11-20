import { beforeAll, describe, expect, it, vi } from "vitest";
import fixture from "../../../fixtures/ifc/connected-walls/building.ifc?raw";
import { IfcAPI } from "web-ifc";
import { IfcWallEditor } from "@teldra/application";
import { IfcModelCache, createIfcWallAdapter, tessellateElements } from "../src/index.js";

const A = "0TeldraWallAAAAAAAAAA1", B = "0TeldraWallBBBBBBBBBB1";
const bytes = new TextEncoder().encode(fixture);
let api: IfcAPI;
beforeAll(async () => { api = new IfcAPI(); await api.Init(); });

describe("IfcModelCache (open the IFC model once per byte revision)", () => {
  it("opens the model once for repeated regeneration of one revision and matches one-shot tessellation", () => {
    const cache = new IfcModelCache(api);
    const open = vi.spyOn(api, "OpenModel");
    try {
      const tessellate = cache.tessellator(bytes, 0);
      const first = tessellate([A]), second = tessellate([A, B]), missing = tessellate(["0TeldraMissingAAAAAAA1"]);
      expect(open).toHaveBeenCalledTimes(1);
      expect(cache.opens).toBe(1);
      expect(missing.get("0TeldraMissingAAAAAAA1")).toBeNull();
      const oneShot = tessellateElements(api, bytes, [A]).get(A)!;
      expect([...first.get(A)!.parts[0]!.positions]).toEqual([...oneShot.parts[0]!.positions]);
      expect([...second.get(A)!.parts[0]!.positions]).toEqual([...oneShot.parts[0]!.positions]);
    } finally { open.mockRestore(); cache.dispose(); }
  });
  it("re-opens on a new revision, and a stale tessellator still reads its own snapshot", () => {
    const editor = new IfcWallEditor(bytes, createIfcWallAdapter(api));
    const cache = new IfcModelCache(api);
    try {
      const r0 = cache.tessellator(editor.bytes, 0);
      const before = [...r0([A]).get(A)!.parts[0]!.positions];
      editor.apply({ kind: "update", globalId: A, geometry: { start: [0, 0], end: [4, 1], thickness: 0.2, height: 2.5, elevation: 0 } });
      const r1 = cache.tessellator(editor.bytes, 1);
      const after = [...r1([A]).get(A)!.parts[0]!.positions];
      expect(after).not.toEqual(before);
      expect(cache.opens).toBe(2);
      expect([...r0([A]).get(A)!.parts[0]!.positions]).toEqual(before); // stale snapshot, still correct
      expect(cache.opens).toBe(3);
    } finally { cache.dispose(); }
  });
  it("answers existence from the parsed model without a second open", () => {
    const cache = new IfcModelCache(api);
    try {
      const present = cache.existingGlobalIds(bytes, 0, [A, B, "0TeldraMissingAAAAAAA1"]);
      expect([...present].sort()).toEqual([A, B]);
      cache.tessellator(bytes, 0)([A]);
      expect(cache.opens).toBe(1);
    } finally { cache.dispose(); }
  });
  it("dispose closes the open model exactly once and is idempotent", () => {
    const cache = new IfcModelCache(api);
    const close = vi.spyOn(api, "CloseModel");
    try {
      cache.tessellator(bytes, 0)([A]);
      cache.dispose(); cache.dispose();
      expect(close).toHaveBeenCalledTimes(1);
      expect(cache.openRevision).toBeUndefined();
    } finally { close.mockRestore(); }
  });
});
