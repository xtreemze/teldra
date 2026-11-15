import { describe, expect, it } from "vitest";
import {
  wallFromReferenceBaseline, wallReferenceFromCentreline,
  type WallReferenceBaseline,
} from "../src/wall-reference-baseline.js";

describe("BIM wall reference baselines", () => {
  const horizontal = { start:[0,0] as const, end:[4,0] as const, thicknessMetres:0.2, heightMetres:2.6 };

  it("places the left/exterior reference face against the drawn line", () => {
    const wall = wallFromReferenceBaseline(horizontal.start,horizontal.end,0.2,2.6,"exterior");
    expect(wall.start).toEqual([0,-0.1]);
    expect(wall.end).toEqual([4,-0.1]);
  });
  it("places the right/interior reference face against the drawn line", () => {
    const wall = wallFromReferenceBaseline(horizontal.start,horizontal.end,0.2,2.6,"interior");
    expect(wall.start).toEqual([0,0.1]);
    expect(wall.end).toEqual([4,0.1]);
  });
  it("preserves the existing centreline and exact dimensions", () => {
    const wall = wallFromReferenceBaseline(horizontal.start,horizontal.end,0.2,2.6,"centreline");
    expect(wall).toEqual(horizontal);
  });
  it("roundtrips diagonal segments and their reference faces", () => {
    const baselineModes: readonly WallReferenceBaseline[] = ["exterior","centreline","interior"];
    for (const baseline of baselineModes) {
      const wall = wallFromReferenceBaseline([1,2],[4,6],.35,3,baseline);
      const reference = wallReferenceFromCentreline(wall,baseline);
      expect(reference[0][0]).toBeCloseTo(1);
      expect(reference[0][1]).toBeCloseTo(2);
      expect(reference[1][0]).toBeCloseTo(4);
      expect(reference[1][1]).toBeCloseTo(6);
    }
  });
  it("rejects unknown baselines and degenerate geometry", () => {
    expect(() => wallFromReferenceBaseline([0,0],[0,0],0.2,3,"exterior")).toThrow();
    expect(() => wallFromReferenceBaseline([0,0],[4,0],0.2,3,"unknown" as WallReferenceBaseline)).toThrow();
    expect(() => wallReferenceFromCentreline(horizontal,"wrong" as WallReferenceBaseline)).toThrow();
  });
});
