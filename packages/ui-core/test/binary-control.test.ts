import { describe, expect, it } from "vitest";
import { nextBinaryControlValue } from "../src/index.js";

describe("nextBinaryControlValue", () => {
  it("toggles an enabled control", () => {
    expect(nextBinaryControlValue({ on: false })).toBe(true);
    expect(nextBinaryControlValue({ on: true })).toBe(false);
  });

  it("preserves a disabled control", () => {
    expect(nextBinaryControlValue({ on: true, disabled: true })).toBe(true);
    expect(nextBinaryControlValue({ on: false, disabled: true })).toBe(false);
  });
});
