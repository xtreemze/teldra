import { beforeAll, describe, expect, it } from "vitest";
import golden from "../../../fixtures/projects/golden-home/building.ifc?raw";
import walls from "../../../fixtures/ifc/connected-walls/building.ifc?raw";
import { IfcAPI } from "web-ifc";
import * as indexed from "../src/index.js";
import * as legacy from "./legacy/index.js";

/**
 * `test/legacy/` is a frozen copy of the pre-session implementation (full-scan inverse reference lookups,
 * one model open per call). It is the oracle proving the indexed implementation writes identical bytes.
 */
type Impl = typeof indexed;
const enc = (text: string) => new TextEncoder().encode(text);
let api: IfcAPI;
beforeAll(async () => { api = new IfcAPI(); await api.Init(); });
const same = (a: Uint8Array, b: Uint8Array) => { expect(a.length).toBe(b.length); expect(a.every((v, i) => v === b[i])).toBe(true); };

function runChain(start: Uint8Array, steps: Array<(m: Impl, bytes: Uint8Array) => Uint8Array>) {
  let a = start, b = start;
  for (const step of steps) { a = step(indexed, a); b = step(legacy as unknown as Impl, b); same(a, b); }
  return a;
}

describe("indexed implementation is byte-identical to the legacy implementation", () => {
  it("golden-home furniture lifecycle and pose chain", () => {
    const chair = golden.match(/^#\d+=IFCFURNITURE\('([^']+)',\$,'Chair'/m)![1]!;
    const g1 = "2gEfmKcdn6c9fX3LLRJBkX", g2 = "1gEfmKcdn6c9fX3LLRJBkY", g3 = "0gEfmKcdn6c9fX3LLRJBkZ";
    runChain(enc(golden), [
      (m, b) => m.duplicateFurniture(api, b, chair, g1, { offset: [0.5, 0, 0], name: "Copy" }),
      (m, b) => m.writeFurniturePose(api, b, g1, { position: [2, 1, 0], yawRadians: 0.4 }),
      (m, b) => m.duplicateFurniture(api, b, g1, g2),
      (m, b) => m.removeFurniture(api, b, g1),
      (m, b) => m.duplicateFurniture(api, b, chair, g3, { offset: [0, 1, 0] }),
      (m, b) => m.removeFurniture(api, b, g2),
      (m, b) => m.removeFurniture(api, b, g3),
    ]);
  });
  it("connected-walls update/create/remove chain", () => {
    const first = walls.match(/IFCWALL(?:STANDARDCASE)?\('([^']+)'/)![1]!;
    const storey = walls.match(/IFCBUILDINGSTOREY\('([^']+)'/)![1]!;
    const fresh = "0TeldraWallEEEEEEEEEE1";
    const start = enc(walls);
    const record = indexed.readWall(api, start, first);
    expect(legacy.readWall(api, start, first)).toEqual(record);
    expect(indexed.planWallUpdate(api, start, first, { ...record, thickness: 0.3 })).toEqual(legacy.planWallUpdate(api, start, first, { ...record, thickness: 0.3 }));
    runChain(start, [
      (m, b) => m.updateWall(api, b, first, { ...record, end: [record.end[0] + 0.5, record.end[1]] }),
      (m, b) => m.createWall(api, b, { globalId: fresh, storeyGlobalId: storey, name: "New", geometry: { start: [0, 9], end: [4, 9], thickness: 0.2, height: 2.8, elevation: 0 } }),
      (m, b) => m.updateWall(api, b, fresh, { start: [0, 9], end: [4, 10], thickness: 0.3, height: 2.8, elevation: 0 }),
      (m, b) => m.removeWall(api, b, fresh),
    ]);
  });
});
