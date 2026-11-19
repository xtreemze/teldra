import {
  constrainPlanAngle, type IfcWallChange, type IfcWallEditor, type IfcWallGeometry, type IfcWallOperation,
} from "@teldra/application";
import type { PlanPoint, PlanWall } from "@teldra/projection";

/** Pure (framework-free) plan editing rules: snapping, geometry builders and refusal explanations. */
export const GRID_METRES = 0.25;
const round = (v: number) => Math.round(v * 1e9) / 1e9;
const roundPoint = (p: PlanPoint): PlanPoint => [round(p[0]), round(p[1])];

export type SnapKind = "endpoint" | "midpoint" | "perpendicular" | "angle" | "grid" | "none";
export type PlanSegment = readonly [PlanPoint, PlanPoint];
export interface SnapOptions {
  readonly gridEnabled: boolean;
  readonly gridMetres?: number;
  /** Axis angle increment in degrees; 0 disables. Needs `anchor`. */
  readonly angleStepDegrees: number;
  /** Fixed point the new/dragged point is measured from (the other wall end). */
  readonly anchor?: PlanPoint | null;
  /** Existing wall endpoints in canonical metres. */
  readonly endpoints: readonly PlanPoint[];
  /** Existing wall reference segments, for midpoint and perpendicular snaps. Optional. */
  readonly segments?: readonly PlanSegment[];
  /** Capture distance for endpoints in canonical metres. */
  readonly endpointRadiusMetres: number;
}
export interface SnapResult { readonly point: PlanPoint; readonly kind: SnapKind }

function nearest(raw: PlanPoint, candidates: readonly PlanPoint[], radius: number): PlanPoint | null {
  let best: PlanPoint | null = null, bestDistance = radius;
  for (const c of candidates) { const d = Math.hypot(c[0] - raw[0], c[1] - raw[1]); if (d <= bestDistance) { best = c; bestDistance = d; } }
  return best;
}
/** Foot of the perpendicular from `from` onto the segment (clamped to the segment). */
export function perpendicularFoot(from: PlanPoint, [a, b]: PlanSegment): PlanPoint {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return a;
  const t = Math.min(1, Math.max(0, ((from[0] - a[0]) * dx + (from[1] - a[1]) * dy) / len2));
  return [a[0] + t * dx, a[1] + t * dy];
}
export const wallSegments = (walls: readonly PlanWall[], excludedWallIds: ReadonlySet<string>): PlanSegment[] =>
  walls.filter((w) => !excludedWallIds.has(w.ifcGlobalId)).map((w) => [w.start, w.end] as const);

/** Endpoint > midpoint > perpendicular > axis angle (with grid-snapped length) > grid > raw. Never reads or writes canonical state. */
export function snapPlanPoint(raw: PlanPoint, options: SnapOptions): SnapResult {
  const radius = options.endpointRadiusMetres;
  const endpoint = nearest(raw, options.endpoints, radius);
  if (endpoint) return { point: roundPoint(endpoint), kind: "endpoint" };
  const segments = options.segments ?? [];
  const middle = nearest(raw, segments.map(([a, b]): PlanPoint => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), radius);
  if (middle) return { point: roundPoint(middle), kind: "midpoint" };
  if (options.anchor) {
    const feet = segments.map((segment) => perpendicularFoot(options.anchor!, segment))
      .filter((foot) => Math.hypot(foot[0] - options.anchor![0], foot[1] - options.anchor![1]) > 1e-6);
    const foot = nearest(raw, feet, radius);
    if (foot) return { point: roundPoint(foot), kind: "perpendicular" };
  }
  const grid = options.gridMetres ?? GRID_METRES;
  const anchor = options.anchor;
  if (anchor && options.angleStepDegrees > 0 && Math.hypot(raw[0] - anchor[0], raw[1] - anchor[1]) > 1e-6) {
    let point = constrainPlanAngle(anchor, raw, options.angleStepDegrees);
    if (options.gridEnabled) {
      const length = Math.hypot(point[0] - anchor[0], point[1] - anchor[1]);
      const snapped = Math.max(grid, Math.round(length / grid) * grid);
      point = [anchor[0] + (point[0] - anchor[0]) * snapped / length, anchor[1] + (point[1] - anchor[1]) * snapped / length];
    }
    return { point: roundPoint(point), kind: "angle" };
  }
  if (options.gridEnabled) return { point: roundPoint([Math.round(raw[0] / grid) * grid, Math.round(raw[1] / grid) * grid]), kind: "grid" };
  return { point: roundPoint(raw), kind: "none" };
}

/** Endpoints of walls, minus `excluded` points (e.g. the endpoint being dragged and its connected twins). */
export function wallEndpoints(walls: readonly PlanWall[], excludedWallIds: ReadonlySet<string>, excludedPoints: readonly PlanPoint[] = []): PlanPoint[] {
  const out: PlanPoint[] = [];
  for (const wall of walls) {
    if (excludedWallIds.has(wall.ifcGlobalId)) continue;
    for (const p of [wall.start, wall.end]) {
      if (!excludedPoints.some((e) => Math.hypot(e[0] - p[0], e[1] - p[1]) < 1e-6)) out.push(p);
    }
  }
  return out;
}

export const geometryOf = (wall: PlanWall): IfcWallGeometry =>
  ({ start: wall.start as [number, number], end: wall.end as [number, number], thickness: wall.thickness, height: wall.height, elevation: wall.elevation });

export type WallEndName = "start" | "end";
export const moveEndpoint = (wall: PlanWall, end: WallEndName, point: PlanPoint): IfcWallGeometry =>
  ({ ...geometryOf(wall), [end]: roundPoint(point) });
export const translateWall = (wall: PlanWall, start: PlanPoint): IfcWallGeometry => {
  const dx = start[0] - wall.start[0], dy = start[1] - wall.start[1];
  return { ...geometryOf(wall), start: roundPoint(start), end: roundPoint([wall.end[0] + dx, wall.end[1] + dy]) };
};
/** Changes length along the current direction, keeping `start` fixed. */
export function resizeWallLength(wall: PlanWall, length: number): IfcWallGeometry {
  if (!Number.isFinite(length) || length <= 0) throw new Error("Length must be a positive number of metres.");
  const current = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  if (current < 1e-9) throw new Error("Cannot resize a zero-length wall.");
  const k = length / current;
  return { ...geometryOf(wall), end: roundPoint([wall.start[0] + (wall.end[0] - wall.start[0]) * k, wall.start[1] + (wall.end[1] - wall.start[1]) * k]) };
}
export const updateOp = (globalId: string, geometry: IfcWallGeometry): IfcWallOperation => ({ kind: "update", globalId, geometry });

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
/** A fresh 22-character IFC GlobalId that is not in `taken`. Uses crypto randomness when available. */
export function newIfcGlobalId(taken: ReadonlySet<string>, random: (n: number) => number[] = defaultRandom): string {
  for (;;) {
    const r = random(22);
    const id = r.map((v, i) => ALPHABET[i === 0 ? v % 4 : v % 64]).join("");
    if (!taken.has(id)) return id;
  }
}
function defaultRandom(n: number): number[] {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes];
}

export type EditOutcome =
  | { readonly ok: true; readonly changes: readonly IfcWallChange[] }
  | { readonly ok: false; readonly code: string; readonly message: string };

const REFUSALS: Record<string, string> = {
  "hosted-opening": "Refused: this wall (or a wall joined to it) hosts a door or window opening. Moving, resizing or deleting it would orphan the opening, so nothing was changed.",
  "wall-referenced": "Refused: other IFC elements still reference this wall, so nothing was changed.",
  "unsupported-relationship": "Refused: this wall takes part in an IFC relationship Teldra cannot rewrite safely yet (for example a path connection when deleting). Nothing was changed.",
  "shared-material": "Refused: this wall shares its material layer set with other walls. Nothing was changed.",
  "unsupported-material": "Refused: this wall's material layers cannot follow a thickness change yet. Nothing was changed.",
  "shared-geometry": "Refused: this wall shares IFC geometry with other elements. Nothing was changed.",
  "unsupported-representation": "Refused: this wall's IFC representation is not a plain Teldra wall. Nothing was changed.",
  "unsupported-placement": "Refused: this wall's IFC placement is not supported for editing. Nothing was changed.",
};
export function explainRefusal(error: unknown): { code: string; message: string } {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "refused";
  const detail = error instanceof Error ? error.message : String(error);
  return { code, message: REFUSALS[code] ?? `Refused: ${detail}` };
}

/** Dry-runs an operation on the shared editor. Never mutates bytes or history. */
export function tryPreview(editor: IfcWallEditor, operation: IfcWallOperation): EditOutcome {
  try { return { ok: true, changes: editor.preview(operation).changes }; }
  catch (error) { return { ok: false, ...explainRefusal(error) }; }
}
/** Commits one undo unit on the shared editor, or reports why it was refused (history unchanged). */
export function tryApply(editor: IfcWallEditor, operations: IfcWallOperation | readonly IfcWallOperation[]): EditOutcome {
  try { return { ok: true, changes: editor.apply(operations).changes }; }
  catch (error) { return { ok: false, ...explainRefusal(error) }; }
}
