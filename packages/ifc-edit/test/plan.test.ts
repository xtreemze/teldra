import { beforeAll, describe, expect, it } from "vitest";
import connected from "../../../fixtures/ifc/connected-walls/building.ifc?raw";
import golden from "../../../fixtures/projects/golden-home/building.ifc?raw";
import { IfcAPI } from "web-ifc";
import { projectStoreyPlan, frameStoreyPlan } from "@teldra/projection";
import { createIfcWallAdapter, readPlanSource } from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);
const A = "0TeldraWallAAAAAAAAAA1", B = "0TeldraWallBBBBBBBBBB1", D = "0TeldraWallDDDDDDDDDD1", STOREY = "0TeldraStoreyAAAAAAAA1";
let api: IfcAPI;
beforeAll(async () => { api = new IfcAPI(); await api.Init(); });

describe("readPlanSource (connected-walls fixture)", () => {
  it("reads storey, walls in world metres, connections and hosted-opening flags", () => {
    const source = readPlanSource(api, enc(connected));
    expect(source.unit).toBe("metre");
    expect(source.storeys).toEqual([{ globalId: STOREY, name: "Ground", elevation: 0 }]);
    expect(source.walls.map((w) => w.globalId)).toEqual([A, B, "0TeldraWallCCCCCCCCCC1", D]);
    const a = source.walls[0]!;
    expect(a).toMatchObject({ storeyGlobalId: STOREY, start: [0, 0], end: [4, 0], thickness: 0.2, height: 2.5 });
    expect(a.connections.length).toBeGreaterThan(0);
    expect(source.walls.find((w) => w.globalId === D)!.hostsOpenings).toBe(true);
    expect(source.walls.filter((w) => w.hostsOpenings).map((w) => w.globalId)).toEqual([D]);
    // The fixture's opening has no geometry: it is skipped, not reported as an error.
    expect(source.openings).toEqual([]);
    expect(source.unreadable).toEqual([]);
  });
  it("preserves IFC GlobalIds through projection and is deterministic", () => {
    const first = readPlanSource(api, enc(connected)), second = readPlanSource(api, enc(connected));
    expect(second).toEqual(first);
    const plan = projectStoreyPlan(first, STOREY, frameStoreyPlan(first, STOREY, { width: 640, height: 400 }));
    expect(plan.walls.map((w) => w.ifcGlobalId)).toEqual(first.walls.map((w) => w.globalId));
  });
  it("reflects canonical edits after the editor applies them", () => {
    const adapter = createIfcWallAdapter(api);
    const moved = adapter.apply(enc(connected), { kind: "update", globalId: A, geometry: { start: [0, 0], end: [4, 1], thickness: 0.2, height: 2.5, elevation: 0 } });
    const source = readPlanSource(api, moved);
    expect(source.walls.find((w) => w.globalId === A)!.end[1]).toBeCloseTo(1);
    expect(source.walls.find((w) => w.globalId === B)!.start[1]).toBeCloseTo(1);
  });
});

describe("readPlanSource (golden-home fixture)", () => {
  let source: ReturnType<typeof readPlanSource>;
  beforeAll(() => { source = readPlanSource(api, enc(golden)); });
  it("reads walls, the space footprint and the hosted door opening footprint", () => {
    expect(source.storeys.map((s) => s.name)).toEqual(["Ground Floor"]);
    const storey = source.storeys[0]!.globalId;
    expect(source.walls).toHaveLength(4);
    expect(source.walls.every((w) => w.storeyGlobalId === storey)).toBe(true);
    expect(source.walls.filter((w) => w.hostsOpenings).map((w) => w.name)).toEqual(["wall:wall0"]);
    expect(source.spaces).toHaveLength(1);
    expect(source.spaces[0]).toMatchObject({ name: "Living room", storeyGlobalId: storey });
    expect(source.spaces[0]!.footprint).toHaveLength(4);
    expect(source.openings).toHaveLength(1);
    expect(source.openings[0]).toMatchObject({ kind: "door", hostWallGlobalId: source.walls.find((w) => w.name === "wall:wall0")!.globalId });
    expect(source.openings[0]!.footprint).toHaveLength(4);
    expect(source.unreadable).toEqual([]);
  });
  it("places the opening inside the host wall in world coordinates", () => {
    const host = source.walls.find((w) => w.name === "wall:wall0")!;
    const xs = source.openings[0]!.footprint.map((p) => p[0]), ys = source.openings[0]!.footprint.map((p) => p[1]);
    const lo = Math.min(host.start[0], host.end[0]) - 0.2, hi = Math.max(host.start[0], host.end[0]) + 0.2;
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(lo);
    expect(Math.max(...xs)).toBeLessThanOrEqual(hi);
    expect(Math.abs(Math.max(...ys) - Math.min(...ys))).toBeCloseTo(0.095, 3);
  });
});
