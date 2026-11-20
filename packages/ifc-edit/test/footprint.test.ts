import { beforeAll, describe, expect, it } from "vitest";
import connected from "../../../fixtures/ifc/connected-walls/building.ifc?raw";
import golden from "../../../fixtures/projects/golden-home/building.ifc?raw";
import { IfcAPI } from "web-ifc";
import { readWallFootprintSegments } from "../src/index.js";

let api: IfcAPI;
beforeAll(async () => { api = new IfcAPI(); await api.Init(); });

describe("readWallFootprintSegments", () => {
  it("returns every parsable wall axis with its GlobalId in IFC world metres", () => {
    const walls = readWallFootprintSegments(api, new TextEncoder().encode(connected));
    expect(walls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(walls.map((w) => w.globalId)).size).toBe(walls.length);
    const a = walls.find((w) => w.globalId === "0TeldraWallAAAAAAAAAA1")!;
    expect(a.start).toEqual([0, 0]);
    expect(a.end).toEqual([4, 0]);
    expect(a.thickness).toBeCloseTo(0.2);
  });

  it("reads the golden-home perimeter and is a pure read", () => {
    const bytes = new TextEncoder().encode(golden);
    const before = bytes.slice();
    const walls = readWallFootprintSegments(api, bytes);
    expect(walls).toHaveLength(4);
    const xs = walls.flatMap((w) => [w.start[0], w.end[0]]), ys = walls.flatMap((w) => [w.start[1], w.end[1]]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(5, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(4, 6);
    expect(bytes).toEqual(before);
  });
});
