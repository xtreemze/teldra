/** Optional tactile confirmation for touch input. Never a prerequisite to an action. */
export type MobileFeedback = "select" | "menu" | "edit" | "applied" | "error";

export function feedbackPattern(kind: MobileFeedback): readonly number[] {
  switch (kind) {
    case "select": return [10];
    case "menu": return [15];
    case "edit": return [15];
    case "applied": return [12, 45, 12];
    case "error": return [25, 55, 25];
  }
}

/** Browser vibration is best-effort and unavailable on some mobile browsers. */
export function signalMobileFeedback(kind: MobileFeedback, enabled = true): boolean {
  if (!enabled || typeof window === "undefined" || typeof navigator === "undefined" ||
      !window.matchMedia?.("(pointer: coarse)").matches || typeof navigator.vibrate !== "function") {
    return false;
  }
  try {
    return navigator.vibrate([...feedbackPattern(kind)]);
  } catch {
    return false;
  }
}
