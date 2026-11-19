import { describe, expect, it } from "vitest";
import {
  canonicalToPlan, frameStoreyPlan, overlayWallChanges, planToCanonical, projectStoreyPlan, wallOutline,
  type PlanSource, type PlanViewport,
} from "../src/index.js";

const S1 = "0TeldraStorey1AAAAAAAA1", S2 = "0TeldraStorey2AAAAAAAA1";
const A = "0TeldraWallAAAAAAAAAA1", B = "0TeldraWallBBBBBBBBBB1", UP = "0TeldraWallUpAAAAAAAA1";
const wall = (globalId: string, storeyGlobalId: string, start: [number, number], end: [number, number], hostsOpenings = false) => ({
  globalId, name: globalId.slice(8, 9), storeyGlobalId, start, end, thickness: 0.2, height: 2.5, elevation: 0,
  connections: [], hostsOpenings,
});
const source: PlanSource = {
  unit: "metre",
  storeys: [{ globalId: S1, name: "Ground", elevation: 0 }, { globalId: S2, name: "First", elevation: 3 }],
  walls: [wall(A, S1, [0, 0], [4, 0], true), wall(B, S1, [4, 0], [4, 3]), wall(UP, S2, [0, 0], [1, 0])],
  spaces: [{ globalId: "0TeldraSpaceAAAAAAAAA1", name: "Room", storeyGlobalId: S1, footprint: [[0, 0], [4, 0], [4, 3], [0, 3]] }],
  openings: [
    { globalId: "0TeldraOpenAAAAAAAAAA1", hostWallGlobalId: A, kind: "door", footprint: [[1, -0.1], [2, -0.1], [2, 0.3], [1, 0.3]] },
    { globalId: "0TeldraOpenUpAAAAAAAA1", hostWallGlobalId: UP, kind: "window", footprint: [[0, 0], [1, 0], [1, 0.2], [0, 0.2]] },
  ],
};
const viewport: PlanViewport = { centre: [2, 1.5], pixelsPerMetre: 100, width: 600, height: 400 };

describe("plan transform", () => {
  it("maps canonical metres to y-down pixels with an explicit flip and round-trips", () => {
    expect(canonicalToPlan(viewport, [2, 1.5])).toEqual([300, 200]);
    expect(canonicalToPlan(viewport, [3, 2.5])).toEqual([400, 100]);
    for (const p of [[0, 0], [-7.25, 3.5], [100, -40]] as const) {
      const back = planToCanonical(viewport, canonicalToPlan(viewport, p));
      expect(back[0]).toBeCloseTo(p[0], 9);
      expect(back[1]).toBeCloseTo(p[1], 9);
    }
  });
  it("frames a storey deterministically and rejects invalid viewports", () => {
    const framed = frameStoreyPlan(source, S1, { width: 600, height: 400 }, 0);
    expect(framed.centre[0]).toBeCloseTo(2);
    expect(framed.centre[1]).toBeCloseTo(1.5);
    expect(frameStoreyPlan(source, S1, { width: 600, height: 400 }, 0)).toEqual(framed);
    expect(() => projectStoreyPlan(source, S1, { ...viewport, pixelsPerMetre: 0 })).toThrow(/viewport/);
  });
});

describe("projectStoreyPlan", () => {
  it("keeps only the active storey and resolves every item to IFC and canonical identity", () => {
    const plan = projectStoreyPlan(source, S1, viewport, { canonicalIdByGlobalId: new Map([[A, "wall:a"]]) });
    expect(plan.walls.map((w) => w.ifcGlobalId)).toEqual([A, B]);
    expect(plan.walls[0]).toMatchObject({ canonicalId: "wall:a", hostsOpenings: true, preview: false, length: 4 });
    expect(plan.walls[1]!.canonicalId).toBeNull();
    expect(plan.spaces.map((s) => s.ifcGlobalId)).toEqual(["0TeldraSpaceAAAAAAAAA1"]);
    expect(plan.openings.map((o) => [o.ifcGlobalId, o.hostWallGlobalId, o.openingKind])).toEqual([["0TeldraOpenAAAAAAAAAA1", A, "door"]]);
    expect(projectStoreyPlan(source, S2, viewport).walls.map((w) => w.ifcGlobalId)).toEqual([UP]);
    expect(() => projectStoreyPlan(source, "missing", viewport)).toThrow(/storey/);
  });
  it("is independent of the viewport: canonical geometry is identical, only plan coordinates differ", () => {
    const a = projectStoreyPlan(source, S1, viewport), b = projectStoreyPlan(source, S1, { ...viewport, centre: [50, 50], pixelsPerMetre: 7 });
    expect(b.walls.map((w) => w.outline)).toEqual(a.walls.map((w) => w.outline));
    expect(b.walls[0]!.planOutline).not.toEqual(a.walls[0]!.planOutline);
    expect(a.walls[0]!.planStart).toEqual([100, 350]);
  });
  it("builds the IFC wall rectangle to the left of start->end", () => {
    expect(wallOutline([0, 0], [4, 0], 0.2)).toEqual([[0, 0], [4, 0], [4, 0.2], [0, 0.2]]);
    const [, , c, d] = wallOutline([4, 0], [4, 3], 0.2);
    expect(c[0]).toBeCloseTo(3.8); expect(d[0]).toBeCloseTo(3.8);
  });
  it("does not mutate its source", () => {
    const before = JSON.stringify(source);
    projectStoreyPlan(source, S1, viewport);
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe("overlayWallChanges", () => {
  const plan = projectStoreyPlan(source, S1, viewport);
  const after = { start: [0, 0] as const, end: [4, 1] as const, thickness: 0.2, height: 2.5, elevation: 0 };
  it("replaces updated walls (including connected neighbours), flags them and leaves the base untouched", () => {
    const next = overlayWallChanges(plan, [{ globalId: A, kind: "updated", after }, { globalId: B, kind: "updated", after: { ...after, start: [4, 1], end: [4, 3] } }]);
    expect(next.walls.map((w) => [w.ifcGlobalId, w.preview])).toEqual([[A, true], [B, true]]);
    expect(next.walls[0]!.end).toEqual([4, 1]);
    expect(next.walls[0]!.name).toBe(plan.walls[0]!.name);
    expect(plan.walls[0]!.end).toEqual([4, 0]);
    expect(plan.walls.every((w) => !w.preview)).toBe(true);
  });
  it("drops removed walls and adds created walls", () => {
    const NEW = "0TeldraNewWallAAAAAAA1";
    const next = overlayWallChanges(plan, [{ globalId: B, kind: "removed", after: null }, { globalId: NEW, kind: "created", after }]);
    expect(next.walls.map((w) => w.ifcGlobalId)).toEqual([A, NEW]);
    expect(next.walls[1]!.preview).toBe(true);
  });
});
