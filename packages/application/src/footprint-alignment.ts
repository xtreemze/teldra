import { ecefToEnu, ecefToGeodetic, enuToEcef, geodeticToEcef, type GeodeticAnchor } from "./building-georeference.js";
import type { BuildingFootprintCandidate, GeoPoint } from "./site-candidates.js";

/** Building-local metres: X east, Y north (project north) before site rotation. */
export type LocalPoint = readonly [number, number];
type Pt = readonly [number, number];

export interface FootprintResidual {
  /** Root-mean-square boundary distance, both directions, metres. */
  readonly rmsMetres: number;
  /** Worst boundary distance (symmetric Hausdorff), metres. */
  readonly maxMetres: number;
  /** IFC footprint area divided by candidate area after alignment. */
  readonly areaRatio: number;
}

export interface FootprintAlignmentHypothesis {
  readonly anchor: GeoPoint;
  readonly projectNorthBearingDegrees: number;
  readonly residual: FootprintResidual;
}

export interface FootprintAlignment extends FootprintAlignmentHypothesis {
  /** Other distinct orientations with comparable residual (e.g. symmetric shapes). */
  readonly alternatives: readonly FootprintAlignmentHypothesis[];
  /** True when a materially different orientation fits about as well. */
  readonly ambiguous: boolean;
}

const RAD = Math.PI / 180;

function checkRing(points: readonly Pt[], label: string): void {
  if (points.length < 3) throw new Error(`${label} needs at least three vertices.`);
  if (!points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) throw new Error(`${label} must contain finite coordinates.`);
}

function signedArea(ring: readonly Pt[]): number {
  let a = 0;
  ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]!; a += p[0] * q[1] - q[0] * p[1]; });
  return a / 2;
}

function ccw(ring: readonly Pt[]): Pt[] {
  return signedArea(ring) < 0 ? [...ring].reverse() : [...ring];
}

function areaCentroid(ring: readonly Pt[]): Pt {
  const a = signedArea(ring);
  if (Math.abs(a) < 1e-9) throw new Error("Footprint is degenerate (zero area).");
  let cx = 0, cy = 0;
  ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]!; const f = p[0] * q[1] - q[0] * p[1]; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f; });
  return [cx / (6 * a), cy / (6 * a)];
}

/** Local building point to site ENU for a clockwise bearing, matching buildingLocalToEcef. */
function rotate(p: Pt, bearingRad: number): Pt {
  const c = Math.cos(bearingRad), s = Math.sin(bearingRad);
  return [c * p[0] + s * p[1], -s * p[0] + c * p[1]];
}

function sample(ring: readonly Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const n = Math.max(1, Math.ceil(length / step));
    for (let k = 0; k < n; k++) out.push([p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n]);
  });
  return out;
}

function nearestOnRing(point: Pt, ring: readonly Pt[]): Pt {
  let best: Pt = ring[0]!, bestD = Infinity;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2));
    const q: Pt = [a[0] + t * dx, a[1] + t * dy];
    const d = (q[0] - point[0]) ** 2 + (q[1] - point[1]) ** 2;
    if (d < bestD) { bestD = d; best = q; }
  });
  return best;
}

function chamfer(a: readonly Pt[], b: readonly Pt[]): { rms: number; max: number; meanShift: Pt } {
  let sum = 0, max = 0, sx = 0, sy = 0, count = 0;
  for (const [ring, other, sign] of [[a, b, 1], [b, a, -1]] as const) {
    for (const p of sample(ring, 0.25)) {
      const q = nearestOnRing(p, other);
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const d = Math.hypot(dx, dy);
      sum += d * d; max = Math.max(max, d); count++;
      sx += sign * dx; sy += sign * dy;
    }
  }
  return { rms: Math.sqrt(sum / count), max, meanShift: [sx / count, sy / count] };
}

function normaliseBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Suggest where the IFC local origin sits on Earth (anchor) and the clockwise
 * bearing of project north so that the IFC footprint best overlays the chosen
 * candidate outline. Orientation hypotheses come from pairing dominant IFC
 * edges with candidate edges (plus their 180 degree flips); each is refined by
 * a small translation search and scored by boundary distance. Pure: nothing
 * is written to IFC or the twin.
 */
export function alignFootprintToCandidate(
  ifcFootprint: readonly LocalPoint[],
  candidate: BuildingFootprintCandidate,
): FootprintAlignment {
  checkRing(ifcFootprint, "IFC footprint");
  const outer = candidate.outer;
  if (outer.length < 3) throw new Error("Candidate footprint needs at least three vertices.");
  if (!outer.every((p) => Number.isFinite(p.latitudeDegrees) && Number.isFinite(p.longitudeDegrees)))
    throw new Error("Candidate footprint must contain finite coordinates.");

  // Candidate to local ENU metres about its own vertex mean.
  const meanLat = outer.reduce((s, p) => s + p.latitudeDegrees, 0) / outer.length;
  const meanLon = outer.reduce((s, p) => s + p.longitudeDegrees, 0) / outer.length;
  const frame: GeodeticAnchor = { latitudeDegrees: meanLat, longitudeDegrees: meanLon, ellipsoidalHeightMetres: 0, clockwiseYawRadians: 0 };
  const q: Pt[] = ccw(outer.map((p) => {
    const [e, n] = ecefToEnu(frame, geodeticToEcef(p.latitudeDegrees, p.longitudeDegrees, 0));
    return [e, n] as Pt;
  }));
  const p: Pt[] = ccw(ifcFootprint);
  const cp = areaCentroid(p), cq = areaCentroid(q);
  const areaP = Math.abs(signedArea(p)), areaQ = Math.abs(signedArea(q));

  const edges = (ring: readonly Pt[]) => ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    return { angle: Math.atan2(b[1] - a[1], b[0] - a[0]), length: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  });
  const pEdges = edges(p).sort((x, y) => y.length - x.length).slice(0, 6);
  const qEdges = edges(q);

  // Clockwise bearing theta maps local math angle a to a - theta; align with candidate edge angle b.
  const bearings: number[] = [];
  for (const pe of pEdges) for (const qe of qEdges) for (const flip of [0, Math.PI]) {
    const deg = normaliseBearing(((pe.angle - qe.angle + flip) / RAD));
    if (!bearings.some((b) => Math.min(Math.abs(b - deg), 360 - Math.abs(b - deg)) < 0.05)) bearings.push(deg);
  }

  const hypotheses = bearings.map((deg) => {
    const theta = deg * RAD;
    const rotated = p.map((v) => rotate(v, theta));
    const rc = rotate(cp, theta);
    let t: Pt = [cq[0] - rc[0], cq[1] - rc[1]];
    let score = chamfer(rotated.map((v) => [v[0] + t[0], v[1] + t[1]] as Pt), q);
    for (let i = 0; i < 6; i++) {
      const next: Pt = [t[0] + score.meanShift[0], t[1] + score.meanShift[1]];
      const nextScore = chamfer(rotated.map((v) => [v[0] + next[0], v[1] + next[1]] as Pt), q);
      if (nextScore.rms >= score.rms) break;
      t = next; score = nextScore;
    }
    // Local origin lands at t in the candidate frame; convert to WGS84.
    const origin = ecefToGeodetic(enuToEcef(frame, [t[0], t[1], 0]));
    return {
      anchor: { latitudeDegrees: origin.latitudeDegrees, longitudeDegrees: origin.longitudeDegrees },
      projectNorthBearingDegrees: deg,
      residual: { rmsMetres: score.rms, maxMetres: score.max, areaRatio: areaP / areaQ },
    } satisfies FootprintAlignmentHypothesis;
  }).sort((x, y) => x.residual.rmsMetres - y.residual.rmsMetres);

  const best = hypotheses[0]!;
  const distinct = (h: FootprintAlignmentHypothesis) => {
    const d = Math.abs(h.projectNorthBearingDegrees - best.projectNorthBearingDegrees);
    return Math.min(d, 360 - d) > 5;
  };
  const tolerance = Math.max(0.25, best.residual.rmsMetres * 1.25);
  const alternatives: FootprintAlignmentHypothesis[] = [];
  for (const h of hypotheses.slice(1)) {
    if (!distinct(h) || h.residual.rmsMetres > tolerance) continue;
    if (alternatives.some((a) => Math.min(Math.abs(a.projectNorthBearingDegrees - h.projectNorthBearingDegrees), 360 - Math.abs(a.projectNorthBearingDegrees - h.projectNorthBearingDegrees)) < 5)) continue;
    alternatives.push(h);
  }
  return { ...best, alternatives, ambiguous: alternatives.length > 0 };
}

export interface WallFootprintSegment {
  readonly start: LocalPoint;
  readonly end: LocalPoint;
  readonly thickness: number;
}

/**
 * Fallback footprint: counter-clockwise convex hull of the wall rectangles'
 * corners. Concave buildings should supply a slab outline instead.
 */
export function convexFootprintFromWalls(walls: readonly WallFootprintSegment[]): LocalPoint[] {
  if (walls.length === 0) throw new Error("At least one wall is required to derive a footprint.");
  const points: Pt[] = [];
  for (const w of walls) {
    const nums = [...w.start, ...w.end, w.thickness];
    if (!nums.every(Number.isFinite)) throw new Error("Wall footprint requires finite coordinates and thickness.");
    const dx = w.end[0] - w.start[0], dy = w.end[1] - w.start[1];
    const len = Math.hypot(dx, dy);
    const h = w.thickness / 2;
    // Square end caps extended by half thickness keep the outer-face corners at wall joints.
    const ux = len === 0 ? 1 : dx / len, uy = len === 0 ? 0 : dy / len;
    for (const [s, dir] of [[w.start, -1], [w.end, 1]] as const) for (const side of [-1, 1])
      points.push([s[0] + dir * ux * h - side * uy * h, s[1] + dir * uy * h + side * ux * h]);
  }
  return hull(points);
}

function hull(points: readonly Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop(); lower.push(p); }
  const upper: Pt[] = [];
  for (const p of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return [...lower, ...upper];
}
