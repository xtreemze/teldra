import { describe, expect, it } from "vitest";
import { nominalDimensionsForScale, scaleForNominalDimensions } from "../src/furniture-dimensions.js";

describe("IFC-backed SH3D nominal dimensions", () => {
  it("preserves immutable source width/depth/height while deriving current local sizes", () => {
    const source = [0.5, 0.8, 1.6] as const;
    const sourceScale = [2, 1, 1.5] as const;
    const current = [3, 0.5, 2.25] as const;
    expect(nominalDimensionsForScale(source, sourceScale, current))
      .toEqual([0.75, 0.4, 2.4]);
    expect(source).toEqual([0.5, 0.8, 1.6]);
    expect(scaleForNominalDimensions(source, sourceScale, [0.75, 0.4, 2.4]))
      .toEqual([3, 0.5, 2.25]);
  });

  it("handles repeated editing without multiplying dimensions twice", () => {
    const source = [0.5, 0.5, 1] as const;
    const first = scaleForNominalDimensions(source, [1,1,1], [1,0.75,1.2]);
    const second = scaleForNominalDimensions(source, [1,1,1], [0.6,0.8,1.4]);
    expect(first).toEqual([2,1.5,1.2]);
    expect(second).toEqual([1.2,1.6,1.4]);
    expect(nominalDimensionsForScale(source, [1,1,1], second))
      .toEqual([0.6,0.8,1.4]);
  });

  it("rejects malformed, zero, negative and implausible dimensions", () => {
    for (const input of [
      [0,1,1],[-1,1,1],[NaN,1,1],[Infinity,1,1],[1,1,1001], [1,1],
    ]) {
      expect(() => scaleForNominalDimensions([1,1,1], [1,1,1], input as [number,number,number])).toThrow();
    }
    expect(() => scaleForNominalDimensions([1e-7,1,1],[1,1,1],[10,1,1])).toThrow();
    expect(() => nominalDimensionsForScale([1000,1,1],[1,1,1],[2,1,1])).toThrow();
  });
});
