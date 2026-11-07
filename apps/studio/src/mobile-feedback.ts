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

/**
 * Optional, quiet, synthetic UI confirmation (not music or render output).
 * A single lazily created AudioContext is shared by the editor's gesture
 * surfaces. Browser autoplay, unsupported devices and reduced-motion
 * preferences result in silence without affecting the action itself.
 */
let feedbackAudio: AudioContext | null = null;
export function soundFrequency(kind: MobileFeedback): number {
  switch (kind) {
    case "select": return 500;
    case "menu": return 460;
    case "edit": return 560;
    case "applied": return 660;
    case "error": return 260;
  }
}

export function signalMobileTone(frequency: number, enabled = false): boolean {
  if (!enabled || !Number.isFinite(frequency) || frequency < 100 || frequency > 2000 ||
      typeof window === "undefined" || typeof AudioContext === "undefined" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
  try {
    feedbackAudio ??= new AudioContext();
    if (feedbackAudio.state !== "running") {
      void feedbackAudio.resume().catch(() => { /* Browser user-activation policy. */ });
      return false;
    }
    const now = feedbackAudio.currentTime;
    const oscillator = feedbackAudio.createOscillator();
    const gain = feedbackAudio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.01, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
    oscillator.connect(gain);
    gain.connect(feedbackAudio.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.05);
    return true;
  } catch {
    return false;
  }
}

export function signalMobileSound(kind: MobileFeedback, enabled = false): boolean {
  return signalMobileTone(soundFrequency(kind), enabled);
}
