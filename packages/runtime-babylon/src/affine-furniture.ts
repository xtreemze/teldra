import { Matrix } from "@babylonjs/core/Maths/math.vector";

/**
 * An upright positive-determinant IFC affine delta can contain shear when
 * expressed as a single Babylon TRS node (R_current * S * R_source^-1).
 * Split its XY block by a 2D SVD into two *ordinary* TRS nodes:
 *
 *     A = parentRoot * localPreRotation  (column-vector notation)
 *
 * Babylon's matrix multiplication uses child.multiply(parent) for that same
 * hierarchy. There is no vertex mutation, material duplication or accuracy
 * loss. Z remains upright and independently scaled.
 */
export interface AffineFurnitureFactors {
  /** Parent node: translation, XY rotation and positive XYZ scale. */
  readonly root: Matrix;
  /** Child node: XY prerotation, no scale/translation. */
  readonly preRotation: Matrix;
  /** Positive magnitudes, in canonical axes (singular values for XY). */
  readonly principalScale: readonly [number, number, number];
}

export function factorUprightFurnitureMatrix(values: readonly number[]): AffineFurnitureFactors {
  if (values.length !== 16 || values.some(v => !Number.isFinite(v)))
    throw new Error("IFC furniture affine matrix must be finite and 4×4.");
  const m = values;
  const near = (a: number, b: number) => Math.abs(a-b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  if (!near(m[2]!,0) || !near(m[3]!,0) || !near(m[6]!,0) || !near(m[7]!,0) ||
      !near(m[8]!,0) || !near(m[9]!,0) || !near(m[11]!,0) || !near(m[15]!,1) ||
      !near(m[10]!,Math.abs(m[10]!)) || m[10]! <= 1e-9)
    throw new Error("IFC furniture affine matrix must be upright, positive and nonsingular.");

  const a = m[0]!, c = m[1]!, b = m[4]!, d = m[5]!;
  const det = a*d-b*c;
  if (!Number.isFinite(det) || det <= 1e-12)
    throw new Error("IFC furniture affine matrix cannot flip or flatten geometry.");
  // Eigenvectors of A^T A are the right singular vectors.
  const t00 = a*a+c*c, t01 = a*b+c*d, t11 = b*b+d*d;
  const theta = 0.5*Math.atan2(2*t01, t00-t11);
  const v1x = Math.cos(theta), v1y = Math.sin(theta);
  const v2x = -v1y, v2y = v1x;
  const s1 = Math.hypot(a*v1x+b*v1y, c*v1x+d*v1y);
  const s2 = Math.hypot(a*v2x+b*v2y, c*v2x+d*v2y);
  if (s1 <= 1e-9 || s2 <= 1e-9 || Math.max(s1,s2,m[10]!) > 1e6)
    throw new Error("IFC affine scale is outside stable rendering bounds.");
  const ux = (a*v1x+b*v1y)/s1, uy = (c*v1x+d*v1y)/s1;
  const root = Matrix.FromArray([
    s1*ux,s1*uy,0,0,-s2*uy,s2*ux,0,0,
    0,0,m[10]!,0,m[12]!,m[13]!,m[14]!,1,
  ]);
  const preRotation = Matrix.FromArray([
    v1x,-v1y,0,0,v1y,v1x,0,0,
    0,0,1,0,0,0,0,1,
  ]);
  // In Babylon row composition the child goes first.
  const joined = preRotation.multiply(root).asArray();
  if (joined.some((v, i) => !near(v, m[i]!)))
    throw new Error("IFC affine factorization lost matrix precision.");
  return {root,preRotation,principalScale:[s1,s2,m[10]!]};
}
