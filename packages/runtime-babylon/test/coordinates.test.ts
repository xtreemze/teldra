import { describe, expect, it } from "vitest";
import { toRenderCoordinates } from "../src/coordinates.js";

describe("toRenderCoordinates", () => {
  it("maps responsive CSS pixels into Babylon render-surface pixels", () => {
    expect(
      toRenderCoordinates(
        { x: 384, y: 240 },
        { width: 768, height: 480 },
        { width: 640, height: 400 },
      ),
    ).toEqual({
      x: 320,
      y: 200,
    });
  });

  it("preserves coordinates when CSS and render sizes match", () => {
    expect(
      toRenderCoordinates(
        { x: 120, y: 80 },
        { width: 640, height: 400 },
        { width: 640, height: 400 },
      ),
    ).toEqual({
      x: 120,
      y: 80,
    });
  });

  it("rejects zero-sized surfaces", () => {
    expect(() =>
      toRenderCoordinates(
        { x: 0, y: 0 },
        { width: 0, height: 400 },
        { width: 640, height: 400 },
      ),
    ).toThrow(RangeError);
  });
});
