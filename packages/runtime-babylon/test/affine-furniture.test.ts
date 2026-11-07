import {describe,expect,it} from "vitest";
import {Matrix,Vector3} from "@babylonjs/core/Maths/math.vector";
import {factorUprightFurnitureMatrix} from "../src/affine-furniture.js";

const pose = (a: number,b: number,c: number,d: number,sz=1) =>
  [a,c,0,0,b,d,0,0,0,0,sz,0,2,3,4,1] as const;

describe("exact IFC affine factorization",() => {
  it.each([
    pose(1,0,0,1), pose(0,-1,1,0),
    pose(1.25,0,0,0.75,0.5),
    // Nonuniform scale conjugated by a rotated original pose: sheared XY block.
    pose(Math.SQRT2,Math.SQRT2,-Math.SQRT1_2,Math.SQRT1_2,0.7),
    pose(0.2,-3,1.5,0.6,2),
  ])("reconstructs exact geometry without a sheared local TRS", matrix => {
    const {root,preRotation,principalScale} = factorUprightFurnitureMatrix(matrix);
    const reconstructed = preRotation.multiply(root).asArray();
    for (let i=0;i<16;i++) expect(reconstructed[i]).toBeCloseTo(matrix[i]!,6);
    expect(principalScale.every(value => value>0)).toBe(true);
    // The inner node is strictly a rotation; no hidden shear or model-space warp.
    const rot = new Vector3(),scaling = new Vector3(),position = new Vector3();
    expect(root.decompose(scaling,undefined,position)).toBe(true);
    expect(preRotation.determinant()).toBeCloseTo(1,7);
    expect(rot.length()).toBe(0);
  });

  it("rejects malformed, tilted, mirrored and nearly singular geometry deltas", () => {
    for (const input of [
      Array.from(Matrix.Identity().asArray()).slice(0,15),
      pose(0,0,0,1),
      pose(-1,0,0,1),
      [1,0,0,0,0,1,0,0,0,0,-1,0,0,0,0,1],
      [1,0,0.3,0,0,1,0,0,0,0,1,0,0,0,0,1],
      [NaN,...Matrix.Identity().asArray().slice(1)],
    ]) expect(() => factorUprightFurnitureMatrix(input)).toThrow();
  });
});
