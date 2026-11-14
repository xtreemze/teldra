import { describe, expect, it } from "vitest";
import {
  constrainPlanAngle, snapPlanPoint, straightWallFootprint,
  validateStraightWallDraft,
} from "../src/architectural-plan-draft.js";

const wall = {
  start: [0, 0] as const,
  end: [4, 0] as const,
  thicknessMetres: 0.2,
  heightMetres: 2.6,
};

describe("CAD wall plan draft (non-authoritative)", () => {
  it("constructs a centred counterclockwise footprint in metres", () => {
    expect(straightWallFootprint(wall)).toEqual([
      [0, -0.1], [4, -0.1], [4, 0.1], [0, 0.1],
    ]);
    expect(wall).toEqual({
      start: [0, 0], end: [4, 0], thicknessMetres: 0.2, heightMetres: 2.6,
    });
  });

  it("rejects degenerate, nonfinite, oversized and invalid wall drafts", () => {
    expect(() => validateStraightWallDraft({...wall, end: [0, 0]})).toThrow(/length/);
    expect(() => validateStraightWallDraft({...wall, end: [NaN, 0]})).toThrow(/finite/);
    expect(() => validateStraightWallDraft({...wall, end: [10001, 0]})).toThrow(/length/);
    expect(() => validateStraightWallDraft({...wall, thicknessMetres: -0.1})).toThrow(/thickness/);
    expect(() => validateStraightWallDraft({...wall, heightMetres: Infinity})).toThrow(/height/);
  });

  it("snaps to nearest wall endpoint with deterministic ties and no source mutation", () => {
    const input = [1.04, 2.04] as const;
    const targets = [
      {canonicalId: "wall:z", point: [1, 2] as const},
      {canonicalId: "wall:a", point: [1, 2] as const},
      {canonicalId: "wall:far", point: [10, 20] as const},
    ];
    const result = snapPlanPoint(input, targets, 0.1);
    expect(result.targetCanonicalId).toBe("wall:a");
    expect(result.point).toEqual([1, 2]);
    expect(result.distanceMetres).toBeCloseTo(Math.hypot(0.04, 0.04));
    expect(input).toEqual([1.04, 2.04]);
    expect(snapPlanPoint(input, targets, 0.01)).toEqual({
      point: [1.04, 2.04], targetCanonicalId: null, distanceMetres: 0,
    });
  });

  it("enforces model-space tolerance and rejects ambiguous malformed candidates", () => {
    expect(() => snapPlanPoint([0, 0], [], -1)).toThrow(/tolerance/);
    expect(() => snapPlanPoint([0, 0], [{canonicalId:"",point:[0,0]}], 1)).toThrow(/identity/);
    expect(() => snapPlanPoint([0, 0], [{canonicalId:"x",point:[Infinity,0]}], 1)).toThrow(/finite/);
  });

  it("constrains angle to CAD increments without changing length", () => {
    const p = constrainPlanAngle([0,0], [4,0.7], 45);
    expect(p[1]).toBeCloseTo(0);
    expect(Math.hypot(...p)).toBeCloseTo(Math.hypot(4,0.7));
    const diag = constrainPlanAngle([1,2], [4,5], 45);
    expect(diag[0]).toBeCloseTo(4);
    expect(diag[1]).toBeCloseTo(5);
    expect(() => constrainPlanAngle([0,0], [0,0], 90)).toThrow(/zero-length/);
  });
});
