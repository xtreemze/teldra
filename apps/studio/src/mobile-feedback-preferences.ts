/** Presentation-only user preferences. Never included in a .teldra project. */
export interface MobileFeedbackPreferences {
  readonly hapticsEnabled: boolean;
  readonly soundEnabled: boolean;
}

const KEY = "teldra:studio:feedback:v1";
const DEFAULTS: MobileFeedbackPreferences = {hapticsEnabled: true, soundEnabled: false};

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function availableStorage(explicit?: PreferenceStorage | null): PreferenceStorage | null {
  if (explicit !== undefined) return explicit;
  return typeof window === "undefined" ? null : window.localStorage;
}

/** Corrupt, disabled, or denied storage must not affect editing. */
export function readMobileFeedbackPreferences(store?: PreferenceStorage | null): MobileFeedbackPreferences {
  try {
    const raw = availableStorage(store)?.getItem(KEY);
    if (!raw) return {...DEFAULTS};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return {...DEFAULTS};
    const candidate = value as Record<string, unknown>;
    return {
      hapticsEnabled: typeof candidate.hapticsEnabled === "boolean" ? candidate.hapticsEnabled : DEFAULTS.hapticsEnabled,
      soundEnabled: typeof candidate.soundEnabled === "boolean" ? candidate.soundEnabled : DEFAULTS.soundEnabled,
    };
  } catch {
    return {...DEFAULTS};
  }
}

/** A failed preference write is deliberately non-fatal. */
export function writeMobileFeedbackPreferences(
  preferences: MobileFeedbackPreferences,
  store?: PreferenceStorage | null,
): boolean {
  try {
    const storage = availableStorage(store);
    if (!storage) return false;
    storage.setItem(KEY, JSON.stringify({
      hapticsEnabled: preferences.hapticsEnabled,
      soundEnabled: preferences.soundEnabled,
    }));
    return true;
  } catch {
    return false;
  }
}
