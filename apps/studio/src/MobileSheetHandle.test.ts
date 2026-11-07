import { describe, expect, it } from "vitest";
import { mobileSheetSwipe } from "./MobileSheetHandle";

describe("mobile sheet detents", () => {
  it("expands a half-height sheet with an upward swipe", () => {
    expect(mobileSheetSwipe("half", -90)).toBe("full");
    expect(mobileSheetSwipe("full", -90)).toBeNull();
  });
  it("moves down one detent at a time and never implicitly cancels an IFC edit", () => {
    expect(mobileSheetSwipe("full", 70)).toBe("half");
    expect(mobileSheetSwipe("half", 70)).toBe("close");
  });
  it("ignores small, invalid or unintentional movement", () => {
    expect(mobileSheetSwipe("half", 40)).toBeNull();
    expect(mobileSheetSwipe("half", -40)).toBeNull();
    expect(mobileSheetSwipe("half", NaN)).toBeNull();
    expect(mobileSheetSwipe("half", 90, 0)).toBeNull();
  });
});
