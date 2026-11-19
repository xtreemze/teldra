import { describe, expect, it } from "vitest";
import {
  alignFootprintToCandidate,
  buildingLocalToEcef,
  convexFootprintFromWalls,
  ecefToGeodetic,
  geodeticAnchorFromSitePlacement,
  sitePlacementFromAlignment,
  type BuildingFootprintCandidate,
  type GeodeticAnchor,
  type LocalPoint,
} from "../src/index.js";

const truth: GeodeticAnchor = {
  latitudeDegrees: 0.5003,
  longitudeDegrees: 0.5025,
  ellipsoidalHeightMetres: 0,
  clockwiseYawRadians: (37 * Math.PI) / 180,
};

/** Asymmetric L-shaped footprint in building-local metres, origin well away from its centroid. */
const lShape: LocalPoint[] = [[2, 3], [26, 3], [26, 11], [14, 11], [14, 21], [2, 21]];
const rectangle: LocalPoint[] = [[0, 0], [20, 0], [20, 10], [0, 10]];

function project(anchor: GeodeticAnchor, local: readonly LocalPoint[], jitter = 0): { latitudeDegrees: number; longitudeDegrees: number }[] {
  return local.map(([x, y], i) => {
    const g = ecefToGeodetic(buildingLocalToEcef(anchor, [x + jitter * Math.sin(i * 7), y + jitter * Math.cos(i * 5), 0]));
    return { latitudeDegrees: g.latitudeDegrees, longitudeDegrees: g.longitudeDegrees };
  });
}

function candidate(outer: ReturnType<typeof project>): BuildingFootprintCandidate {
  return {
    id: "osm:way/1",
    provider: "osm-overpass",
    dataset: "OpenStreetMap",
    outer,
    centroid: outer[0]!,
    attribution: "© OpenStreetMap contributors",
    license: "ODbL-1.0",
    retrievedAt: "2026-01-02T03:04:05Z",
  };
}

const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe("alignFootprintToCandidate", () => {
  it("recovers anchor and clockwise bearing exactly from a noiseless asymmetric footprint", () => {
    const result = alignFootprintToCandidate(lShape, candidate(project(truth, lShape)));
    expect(angleDiff(result.projectNorthBearingDegrees, 37)).toBeLessThan(0.01);
    expect(Math.abs(result.anchor.latitudeDegrees - truth.latitudeDegrees)).toBeLessThan(2e-8);
    expect(Math.abs(result.anchor.longitudeDegrees - truth.longitudeDegrees)).toBeLessThan(2e-8);
    expect(result.residual.rmsMetres).toBeLessThan(0.01);
    expect(result.residual.maxMetres).toBeLessThan(0.05);
    expect(result.ambiguous).toBe(false);
  });

  it("tolerates decimetre digitisation noise and reports it as residual", () => {
    const result = alignFootprintToCandidate(lShape, candidate(project(truth, lShape, 0.3)));
    expect(angleDiff(result.projectNorthBearingDegrees, 37)).toBeLessThan(2);
    expect(result.residual.rmsMetres).toBeGreaterThan(0.02);
    expect(result.residual.rmsMetres).toBeLessThan(0.6);
  });

  it("is independent of candidate vertex order, start vertex and winding", () => {
    const outer = project(truth, lShape);
    const variants = [outer.slice(2).concat(outer.slice(0, 2)), [...outer].reverse()];
    for (const variant of variants) {
      const result = alignFootprintToCandidate(lShape, candidate(variant));
      expect(angleDiff(result.projectNorthBearingDegrees, 37)).toBeLessThan(0.01);
    }
  });

  it("flags rotational ambiguity for a rectangle and lists the 180 degree alternative", () => {
    const result = alignFootprintToCandidate(rectangle, candidate(project(truth, rectangle)));
    expect(result.ambiguous).toBe(true);
    expect(result.alternatives.some((alt) => angleDiff(alt.projectNorthBearingDegrees, result.projectNorthBearingDegrees) > 179)).toBe(true);
    expect(result.residual.rmsMetres).toBeLessThan(0.01);
  });

  it("reports a large residual when shapes do not match", () => {
    const result = alignFootprintToCandidate(rectangle, candidate(project(truth, lShape)));
    expect(result.residual.rmsMetres).toBeGreaterThan(1);
  });

  it("returns a bearing in [0, 360) and rejects degenerate input", () => {
    const result = alignFootprintToCandidate(lShape, candidate(project({ ...truth, clockwiseYawRadians: -0.1 }, lShape)));
    expect(result.projectNorthBearingDegrees).toBeGreaterThanOrEqual(0);
    expect(result.projectNorthBearingDegrees).toBeLessThan(360);
    expect(() => alignFootprintToCandidate([[0, 0], [1, 1]], candidate(project(truth, lShape)))).toThrow(/at least three/);
    expect(() => alignFootprintToCandidate(lShape, candidate(project(truth, lShape).slice(0, 2)))).toThrow(/at least three/);
    expect(() => alignFootprintToCandidate([[0, 0], [1, 0], [Number.NaN, 1]], candidate(project(truth, lShape)))).toThrow(/finite/);
  });

  it("builds a provisional placement whose anchor maps IFC points back onto the candidate", () => {
    const outer = project(truth, lShape);
    const cand = candidate(outer);
    const alignment = alignFootprintToCandidate(lShape, cand);
    const placement = sitePlacementFromAlignment(alignment, cand, { metres: 40, reference: "ellipsoidal" });
    expect(placement.provenance).toMatchObject({ status: "provisional", source: "osm-overpass", dataset: "OpenStreetMap", sourceObjectId: "osm:way/1" });
    expect(placement.provenance.confirmedAt).toBeUndefined();
    expect(placement.orientation.northReference).toBe("geographic-north");
    const anchor = geodeticAnchorFromSitePlacement(placement);
    const mapped = ecefToGeodetic(buildingLocalToEcef(anchor, [26, 3, 0]));
    expect(Math.abs(mapped.latitudeDegrees - outer[1]!.latitudeDegrees)).toBeLessThan(2e-8);
    expect(Math.abs(mapped.longitudeDegrees - outer[1]!.longitudeDegrees)).toBeLessThan(2e-8);
  });
});

describe("convexFootprintFromWalls", () => {
  it("returns the convex outline of wall-thickness-expanded wall segments in counter-clockwise order", () => {
    const hull = convexFootprintFromWalls([
      { start: [0, 0], end: [10, 0], thickness: 0.4 },
      { start: [10, 0], end: [10, 6], thickness: 0.4 },
      { start: [10, 6], end: [0, 6], thickness: 0.4 },
      { start: [0, 6], end: [0, 0], thickness: 0.4 },
    ]);
    const xs = hull.map((p) => p[0]);
    const ys = hull.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(-0.2, 6);
    expect(Math.max(...xs)).toBeCloseTo(10.2, 6);
    expect(Math.min(...ys)).toBeCloseTo(-0.2, 6);
    expect(Math.max(...ys)).toBeCloseTo(6.2, 6);
    let area = 0;
    hull.forEach((p, i) => { const q = hull[(i + 1) % hull.length]!; area += p[0] * q[1] - q[0] * p[1]; });
    expect(area).toBeGreaterThan(0);
  });

  it("rejects empty or non-finite wall sets", () => {
    expect(() => convexFootprintFromWalls([])).toThrow();
    expect(() => convexFootprintFromWalls([{ start: [0, 0], end: [Number.NaN, 0], thickness: 0.2 }])).toThrow(/finite/);
  });
});
