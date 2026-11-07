import { describe, expect, it } from "vitest";
import { feedbackPattern, signalMobileFeedback, signalMobileSound, soundFrequency } from "./mobile-feedback";

describe("optional mobile haptics", () => {
  it("defines distinct selection, confirmation and error patterns", () => {
    expect(feedbackPattern("select")).toEqual([10]);
    expect(feedbackPattern("applied")).not.toEqual(feedbackPattern("error"));
  });
  it("has bounded original UI tones and a safe disabled-browser fallback", () => {
    expect(soundFrequency("applied")).toBeGreaterThan(soundFrequency("error"));
    expect(soundFrequency("menu")).toBeGreaterThan(100);
    expect(signalMobileSound("edit", false)).toBe(false);
    expect(signalMobileSound("error", true)).toBe(false);
  });
  it("is safe without browser vibration support", () => {
    expect(signalMobileFeedback("menu")).toBe(false);
  });
});
