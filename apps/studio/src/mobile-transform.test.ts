import {describe, expect, it} from "vitest";
import {touchTransformPose} from "./mobile-transform";

const origin = {position: [1, 2, 3] as const, yawRadians: Math.PI / 4};
const a = {x: 30, y: 80};
const b = {x: 130, y: 80};

describe("mobile touch editing previews", () => {
  it("maps two-finger vertical motion to an explicit world axis and preserves yaw", () => {
    const next = touchTransformPose(origin, [a, b], [{x: 30, y: 0}, {x: 130, y: 0}], "translate", "z", 0);
    expect(next?.delta).toBeCloseTo(0.5);
    expect(next?.pose.position).toEqual([1, 2, 3.5]);
    expect(next?.pose.yawRadians).toBe(origin.yawRadians);
    expect(origin.position).toEqual([1, 2, 3]);
  });

  it("snaps movement without affecting the other axes", () => {
    const next = touchTransformPose(origin, [a, b], [{x: 30, y: 43}, {x: 130, y: 43}], "translate", "y", 0.1);
    expect(next?.delta).toBeCloseTo(0.2);
    expect(next?.pose.position).toEqual([1, 2.2, 3]);
  });

  it("twists around canonical Z with an angle snap and no scaling", () => {
    const next = touchTransformPose(origin, [a, b], [{x: 80, y: 30}, {x: 80, y: 130}], "rotate", "x", Math.PI / 12);
    expect(next?.delta).toBeCloseTo(Math.PI / 2);
    expect(next?.pose.yawRadians).toBeCloseTo(origin.yawRadians + Math.PI / 2);
    expect(next?.pose.position).toEqual([1, 2, 3]);
  });

  it("rejects invalid or ambiguous contact positions rather than emitting a transform", () => {
    expect(touchTransformPose(origin, [a, a], [a, b], "rotate", "x", 0)).toBeNull();
    expect(touchTransformPose(origin, [a, b], [{x: NaN, y: 0}, b], "rotate", "x", 0)).toBeNull();
    expect(touchTransformPose(origin, [a, b], [a, b], "translate", "x", -1)).toBeNull();
  });
});
