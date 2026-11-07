import type { FurnitureGeometryScale } from "./ifc-furniture-editor.js";

/** Source width, depth and height in canonical IFC local X/Y/Z metres. */
export type FurnitureSourceDimensions = readonly [number, number, number];

/**
 * SH3D nominal dimensions are immutable provenance. Authored dimensions are a
 * projection of the source width/depth/height through the *relative* IFC
 * MappingTarget. They are not measured triangle bounding-box dimensions.
 */
function finitePositiveTriple(value: readonly number[], label: string): void {
  if (value.length !== 3 || value.some(n => !Number.isFinite(n) || n <= 0 || n > 1000))
    throw new Error(label + " must contain three finite positive values no greater than 1000.");
}

export function nominalDimensionsForScale(
  source: FurnitureSourceDimensions,
  original: FurnitureGeometryScale,
  current: FurnitureGeometryScale,
): FurnitureSourceDimensions {
  finitePositiveTriple(source, "SH3D source dimensions");
  finitePositiveTriple(original, "Original IFC mapping scale");
  finitePositiveTriple(current, "Current IFC mapping scale");
  const result = source.map((metres, i) => metres * current[i]! / original[i]!) as [number, number, number];
  finitePositiveTriple(result, "Current nominal dimensions");
  return result;
}

/** Convert a requested size into the authoritative per-instance IFC MappingTarget. */
export function scaleForNominalDimensions(
  source: FurnitureSourceDimensions,
  original: FurnitureGeometryScale,
  desired: FurnitureSourceDimensions,
): FurnitureGeometryScale {
  finitePositiveTriple(source, "SH3D source dimensions");
  finitePositiveTriple(original, "Original IFC mapping scale");
  finitePositiveTriple(desired, "Requested nominal dimensions");
  const result = source.map((metres, i) => original[i]! * desired[i]! / metres) as [number, number, number];
  finitePositiveTriple(result, "Requested IFC mapping scale");
  return result;
}
