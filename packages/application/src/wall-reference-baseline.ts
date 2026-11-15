import {
  validateStraightWallDraft,
  type PlanPoint,
  type StraightWallDraft,
} from "./architectural-plan-draft.js";

/**
 * Architectural reference baseline, following the convention of BIM wall tools.
 * Exterior is the LEFT face when walking from start to end; interior is RIGHT.
 * IFC coordinates still always receive a centreline, never a renderer-only offset.
 */
export type WallReferenceBaseline = "exterior" | "centreline" | "interior";

/** Convert a drawn face reference to an IFC-ready centreline in metre coordinates. */
export function wallFromReferenceBaseline(
  start: PlanPoint,
  end: PlanPoint,
  thicknessMetres: number,
  heightMetres: number,
  baseline: WallReferenceBaseline,
): StraightWallDraft {
  const reference: StraightWallDraft = {
    start, end, thicknessMetres, heightMetres,
  };
  validateStraightWallDraft(reference);
  if (baseline !== "centreline" && baseline !== "exterior" && baseline !== "interior")
    throw new Error("Unsupported wall reference baseline.");
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  // Left normal: (-dy, dx). A drawn exterior (left) face has its centreline
  // half a thickness to the right; an interior (right) face to the left.
  const sign = baseline === "exterior" ? -1 : baseline === "interior" ? 1 : 0;
  const offset = sign * thicknessMetres / (2 * length);
  const deltaX = -dy * offset, deltaY = dx * offset;
  return validateStraightWallDraft({
    start: [start[0] + deltaX, start[1] + deltaY],
    end: [end[0] + deltaX, end[1] + deltaY],
    thicknessMetres, heightMetres,
  });
}

/** Inverse of wallFromReferenceBaseline for switching tools without moving geometry. */
export function wallReferenceFromCentreline(
  wall: StraightWallDraft,
  baseline: WallReferenceBaseline,
): readonly [PlanPoint, PlanPoint] {
  validateStraightWallDraft(wall);
  if (baseline !== "centreline" && baseline !== "exterior" && baseline !== "interior")
    throw new Error("Unsupported wall reference baseline.");
  const dx = wall.end[0] - wall.start[0], dy = wall.end[1] - wall.start[1];
  const length = Math.hypot(dx, dy);
  const sign = baseline === "exterior" ? 1 : baseline === "interior" ? -1 : 0;
  const offset = sign * wall.thicknessMetres / (2 * length);
  const deltaX = -dy * offset, deltaY = dx * offset;
  return [
    [wall.start[0] + deltaX, wall.start[1] + deltaY],
    [wall.end[0] + deltaX, wall.end[1] + deltaY],
  ];
}
