import type { PlanPoint } from "@teldra/projection";

/** Typed numeric entry during a gesture: Sweet Home 3D style length/angle, Blender G style axis constraint. */
export type AxisConstraint = "x" | "y" | null;
/** NaN means "not typed": that quantity follows the pointer. */
export interface TypedEntry { readonly length: number; readonly angleDegrees: number; readonly axis: AxisConstraint }
export const NO_ENTRY: TypedEntry = { length: NaN, angleDegrees: NaN, axis: null };
const round = (v: number) => Math.round(v * 1e9) / 1e9;
const roundPoint = (p: PlanPoint): PlanPoint => [round(p[0]), round(p[1])];

/** Parses a partially typed number buffer; incomplete input ("", "-", ".") is "not typed". */
export const parseTyped = (text: string): number => (/^-?(\d+\.?\d*|\.\d+)$/.test(text.trim()) ? Number(text) : NaN);
export const hasTypedEntry = (entry: TypedEntry): boolean =>
  !Number.isNaN(entry.length) || !Number.isNaN(entry.angleDegrees) || entry.axis !== null;

/**
 * Point at `length` and `angle` from `anchor`; untyped quantities follow `raw`. An axis constraint fixes the
 * angle to horizontal (x) or vertical (y), signed towards the pointer.
 */
export function polarTarget(anchor: PlanPoint, raw: PlanPoint, entry: TypedEntry): PlanPoint {
  let dx = raw[0] - anchor[0], dy = raw[1] - anchor[1];
  if (entry.axis === "x") dy = 0; else if (entry.axis === "y") dx = 0;
  let length = Math.hypot(dx, dy);
  let angle = entry.axis === "x" ? (dx >= 0 ? 0 : Math.PI) : entry.axis === "y" ? (dy >= 0 ? Math.PI / 2 : -Math.PI / 2) : Math.atan2(dy, dx);
  if (!Number.isNaN(entry.length)) length = entry.length;
  if (!Number.isNaN(entry.angleDegrees) && entry.axis === null) angle = entry.angleDegrees * Math.PI / 180;
  return roundPoint([anchor[0] + length * Math.cos(angle), anchor[1] + length * Math.sin(angle)]);
}

/**
 * Moves `origin` along an axis (default x when a number is typed): the typed length is the signed displacement
 * in metres, otherwise the pointer's projection onto the axis.
 */
export function axisDisplacement(origin: PlanPoint, raw: PlanPoint, pointerOrigin: PlanPoint, entry: TypedEntry): PlanPoint {
  const axis = entry.axis ?? "x";
  const d = !Number.isNaN(entry.length) ? entry.length : axis === "x" ? raw[0] - pointerOrigin[0] : raw[1] - pointerOrigin[1];
  return roundPoint(axis === "x" ? [origin[0] + d, origin[1]] : [origin[0], origin[1] + d]);
}
