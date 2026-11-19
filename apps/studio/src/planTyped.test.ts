import { describe, expect, it } from "vitest";
import { perpendicularFoot, snapPlanPoint } from "./planEditing";
import { axisDisplacement, hasTypedEntry, NO_ENTRY, parseTyped, polarTarget } from "./planTyped";

describe("midpoint and perpendicular snaps", () => {
  const base = { gridEnabled: false, angleStepDegrees: 0, endpoints: [], endpointRadiusMetres: 0.3 };
  const segments = [[[0, 0], [4, 0]] as const];
  it("snaps to midpoints and to the perpendicular foot from the anchor, after endpoints", () => {
    expect(snapPlanPoint([2.1, 0.1], { ...base, segments })).toEqual({ point: [2, 0], kind: "midpoint" });
    expect(snapPlanPoint([0.05, 0.1], { ...base, segments, endpoints: [[0, 0]] }).kind).toBe("endpoint");
    expect(snapPlanPoint([1.0, 0.1], { ...base, segments, anchor: [1, 3] })).toEqual({ point: [1, 0], kind: "perpendicular" });
    expect(snapPlanPoint([1.0, 1.0], { ...base, segments, anchor: [1, 3] }).kind).toBe("none");
    expect(perpendicularFoot([9, 3], [[0, 0], [4, 0]])).toEqual([4, 0]);
  });
});

describe("typed numeric entry", () => {
  it("parses partial buffers", () => {
    expect(["", "-", ".", "abc"].map(parseTyped).every(Number.isNaN)).toBe(true);
    expect(parseTyped("-2.5")).toBe(-2.5);
    expect(hasTypedEntry(NO_ENTRY)).toBe(false);
  });
  it("builds length/angle and axis-constrained targets", () => {
    expect(polarTarget([0, 0], [3, 0.2], { ...NO_ENTRY, length: 2, angleDegrees: 90 })).toEqual([0, 2]);
    expect(polarTarget([1, 1], [4, 1], { ...NO_ENTRY, length: 3 })).toEqual([4, 1]);
    expect(polarTarget([0, 0], [3, 2], { ...NO_ENTRY, axis: "x" })).toEqual([3, 0]);
    expect(polarTarget([0, 0], [1, -5], { ...NO_ENTRY, axis: "y", length: 4 })).toEqual([0, -4]);
  });
  it("moves along an axis by pointer projection or typed displacement", () => {
    expect(axisDisplacement([4, 0], [5, 9], [4, 0], { ...NO_ENTRY, axis: "y" })).toEqual([4, 9]);
    expect(axisDisplacement([4, 0], [5, 9], [4, 0], { ...NO_ENTRY, length: -1.5 })).toEqual([2.5, 0]);
  });
});
