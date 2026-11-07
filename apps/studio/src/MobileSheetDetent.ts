export type MobileSheetDetent = "half" | "full";

/**
 * Only the explicit mobile sheet handle interprets vertical drags.
 * No event handling or application state is involved in this decision.
 */
export function mobileSheetSwipe(
  detent: MobileSheetDetent,
  deltaY: number,
  threshold = 52,
): MobileSheetDetent | "close" | null {
  if (!Number.isFinite(deltaY) || !Number.isFinite(threshold) || threshold <= 0) return null;
  if (deltaY <= -threshold) return detent === "full" ? null : "full";
  if (deltaY >= threshold) return detent === "full" ? "half" : "close";
  return null;
}
