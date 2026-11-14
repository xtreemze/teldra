/**
 * Renderer-neutral architectural wall *draft* geometry.
 *
 * A draft is not canonical IFC and must never be persisted as an alternative
 * geometry source. An IFC-aware authoring command must validate and commit a
 * supported wall representation before users can Apply it.
 *
 * Canonical plan coordinates are metres, right-handed local X/Y; Z is up.
 */
export type PlanPoint = readonly [number, number];
export interface StraightWallDraft {
  readonly start: PlanPoint;
  readonly end: PlanPoint;
  readonly thicknessMetres: number;
  readonly heightMetres: number;
}
export interface PlanSnapCandidate {
  readonly point: PlanPoint;
  readonly canonicalId: string;
}
export interface PlanSnapResult {
  readonly point: PlanPoint;
  readonly targetCanonicalId: string | null;
  readonly distanceMetres: number;
}

const WALL_EPSILON_METRES = 1e-6;
const MAX_WALL_LENGTH_METRES = 10_000;
const MAX_WALL_DIMENSION_METRES = 100;

function checkPoint(point: PlanPoint): void {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
    throw new Error("Plan point must have two finite metre coordinates.");
  }
}

/** Validate a straight, vertical constant-thickness wall for preview. */
export function validateStraightWallDraft(wall: StraightWallDraft): StraightWallDraft {
  checkPoint(wall.start);
  checkPoint(wall.end);
  const length = Math.hypot(
    wall.end[0] - wall.start[0],
    wall.end[1] - wall.start[1],
  );
  if (length < WALL_EPSILON_METRES || length > MAX_WALL_LENGTH_METRES) {
    throw new Error("Straight wall length is outside supported bounds.");
  }
  if (!Number.isFinite(wall.thicknessMetres) ||
      wall.thicknessMetres <= 0 ||
      wall.thicknessMetres > MAX_WALL_DIMENSION_METRES) {
    throw new Error("Straight wall thickness must be positive and finite.");
  }
  if (!Number.isFinite(wall.heightMetres) ||
      wall.heightMetres <= 0 ||
      wall.heightMetres > MAX_WALL_DIMENSION_METRES) {
    throw new Error("Straight wall height must be positive and finite.");
  }
  return wall;
}

/** The four corners of the centred wall's plan footprint, counterclockwise. */
export function straightWallFootprint(wall: StraightWallDraft):
    readonly [PlanPoint, PlanPoint, PlanPoint, PlanPoint] {
  validateStraightWallDraft(wall);
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const norm = Math.hypot(dx, dy);
  const nx = -dy / norm * wall.thicknessMetres / 2;
  const ny = dx / norm * wall.thicknessMetres / 2;
  return [
    [wall.start[0] - nx, wall.start[1] - ny],
    [wall.end[0] - nx, wall.end[1] - ny],
    [wall.end[0] + nx, wall.end[1] + ny],
    [wall.start[0] + nx, wall.start[1] + ny],
  ];
}

/**
 * Nearest architectural snap in *model metres*, independent of camera zoom.
 * Sort equal-distance candidates by canonical ID for stable selection.
 */
export function snapPlanPoint(
  point: PlanPoint,
  candidates: readonly PlanSnapCandidate[],
  toleranceMetres: number,
): PlanSnapResult {
  checkPoint(point);
  if (!Number.isFinite(toleranceMetres) || toleranceMetres < 0 ||
      toleranceMetres > MAX_WALL_LENGTH_METRES) {
    throw new Error("Snap tolerance must be a nonnegative finite distance in metres.");
  }
  let best: { point: PlanPoint; canonicalId: string; distance: number } | undefined;
  for (const candidate of candidates) {
    checkPoint(candidate.point);
    if (candidate.canonicalId.trim().length === 0) {
      throw new Error("Snap candidate needs a canonical identity.");
    }
    const distance = Math.hypot(
      point[0] - candidate.point[0],
      point[1] - candidate.point[1],
    );
    if (distance > toleranceMetres) continue;
    if (!best || distance < best.distance ||
        (distance === best.distance && candidate.canonicalId < best.canonicalId)) {
      best = {point: candidate.point, canonicalId: candidate.canonicalId, distance};
    }
  }
  return best
    ? { point: [...best.point] as [number, number], targetCanonicalId: best.canonicalId, distanceMetres: best.distance }
    : { point: [...point] as [number, number], targetCanonicalId: null, distanceMetres: 0 };
}

/** Constrain a wall endpoint to the nearest multiple of a specified angle. */
export function constrainPlanAngle(
  start: PlanPoint,
  end: PlanPoint,
  incrementDegrees: number,
): PlanPoint {
  checkPoint(start);
  checkPoint(end);
  if (!Number.isFinite(incrementDegrees) ||
      incrementDegrees <= 0 || incrementDegrees > 180) {
    throw new Error("Angle increment must be between 0 and 180 degrees.");
  }
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length < WALL_EPSILON_METRES) throw new Error("Cannot constrain a zero-length wall.");
  const angle = Math.atan2(dy, dx);
  const step = incrementDegrees * Math.PI / 180;
  const snapped = Math.round(angle / step) * step;
  return [start[0] + length * Math.cos(snapped), start[1] + length * Math.sin(snapped)];
}
