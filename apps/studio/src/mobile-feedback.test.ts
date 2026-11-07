import { describe, expect, it } from "vitest";
import { feedbackPattern, signalMobileFeedback } from "./mobile-feedback";

describe("optional mobile haptics", () => {
  it("defines distinct selection, confirmation and error patterns", () => {
    expect(feedbackPattern("select")).toEqual([10]);
    expect(feedbackPattern("applied")).not.toEqual(feedbackPattern("error"));
  });
  it("is safe without browser vibration support", () => {
    expect(signalMobileFeedback("menu")).toBe(false);
  });
});
