import type { FurnitureGeometryScale, FurnitureWorldPose } from "@teldra/application";

/** Gesture mathematics only. No renderer or canonical IFC state is mutated here. */
export interface TouchPoint { readonly x: number; readonly y: number }
export type WorldAxis = "x" | "y" | "z";
export type TouchTransformMode = "translate" | "rotate";
export interface TouchTransformResult {
  readonly pose: FurnitureWorldPose;
  readonly delta: number; // metres for move, radians for rotate
}

const PIXELS_PER_METRE = 160;

function midpoint(a: TouchPoint, b: TouchPoint): TouchPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function angle(a: TouchPoint, b: TouchPoint): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function distance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * A two-finger gesture starts from an immutable preview pose. Moving upward along
 * a chosen world axis increases metres; twisting counterclockwise increases yaw.
 * Restrict to upright Z rotation, never synthesize mesh-only scale.
 */
export function touchTransformPose(
  base: FurnitureWorldPose,
  start: readonly [TouchPoint, TouchPoint],
  current: readonly [TouchPoint, TouchPoint],
  mode: TouchTransformMode,
  axis: WorldAxis,
  snap: number,
): TouchTransformResult | null {
  if (![...base.position, base.yawRadians, ...start.flatMap(p => [p.x, p.y]),
    ...current.flatMap(p => [p.x, p.y]), snap].every(Number.isFinite) ||
    snap < 0 || distance(...start) < 32 || distance(...current) < 24) return null;

  if (mode === "rotate") {
    const a = angle(...current) - angle(...start);
    const raw = Math.atan2(Math.sin(a), Math.cos(a));
    // The inspector applies snapping to absolute world yaw, not relative
    // gesture distance. Match its final value to prevent Apply jumps.
    const delta = Math.abs(raw) < 0.005 ? 0 :
      snap > 0 ? Math.round((base.yawRadians + raw) / snap) * snap - base.yawRadians : raw;
    return {
      pose: { position: [...base.position] as [number, number, number],
        yawRadians: base.yawRadians + delta },
      delta,
    };
  }

  const metres = (midpoint(...start).y - midpoint(...current).y) / PIXELS_PER_METRE;
  const position: [number, number, number] = [...base.position];
  const index = {x: 0, y: 1, z: 2}[axis];
  // Match IfcFurnitureEdit's absolute world-position snapping.
  const delta = Math.abs(metres) < 0.002 ? 0 :
    snap > 0 ? Math.round((base.position[index]! + metres) / snap) * snap - base.position[index]! : metres;
  position[index] = position[index]! + delta;
  return { pose: {position, yawRadians: base.yawRadians}, delta };
}

export type ScaleAxis = "all" | WorldAxis;

export interface TouchScaleResult {
  readonly scale: FurnitureGeometryScale;
  readonly ratio: number;
}

/**
 * Pinch edits **canonical mapped geometry scale**, never scene-node scaling.
 * Each gesture uses an immutable baseline; only the existing IFC transaction
 * can commit the resulting preview. Unsupported IFC objects cannot enter this
 * path at the workspace level.
 */
export function touchScalePreview(
  base: FurnitureGeometryScale,
  start: readonly [TouchPoint, TouchPoint],
  current: readonly [TouchPoint, TouchPoint],
  axis: ScaleAxis,
): TouchScaleResult | null {
  const values = [...base, ...start.flatMap(p => [p.x, p.y]),
    ...current.flatMap(p => [p.x, p.y])];
  if (!values.every(Number.isFinite) || base.some(v => v <= 0 || v > 1000)) return null;
  const initial = distance(...start), final = distance(...current);
  if (initial < 32 || final < 24) return null;
  const ratio = final / initial;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const scale: [number, number, number] = [...base];
  for (const key of ["x", "y", "z"] as const) {
    if (axis !== "all" && key !== axis) continue;
    const index = {x: 0, y: 1, z: 2}[key];
    const value = base[index]! * ratio;
    if (!Number.isFinite(value) || value < 0.000001 || value > 1000) return null;
    scale[index] = value;
  }
  return {scale, ratio};
}
