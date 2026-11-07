import { describe, expect, it } from "vitest";
import { readMobileFeedbackPreferences, writeMobileFeedbackPreferences } from "./mobile-feedback-preferences";

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set("teldra:studio:feedback:v1", initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {values.set(key, value);},
  };
}

describe("mobile feedback preferences", () => {
  it("defaults to optional haptics on and sound off", () => {
    expect(readMobileFeedbackPreferences(storage())).toEqual({hapticsEnabled: true, soundEnabled: false});
  });

  it("round-trips two independently controlled boolean preferences", () => {
    const store = storage();
    expect(writeMobileFeedbackPreferences({hapticsEnabled: false, soundEnabled: true}, store)).toBe(true);
    expect(readMobileFeedbackPreferences(store)).toEqual({hapticsEnabled: false, soundEnabled: true});
  });

  it("rejects malformed data and invalid values without enabling sounds", () => {
    expect(readMobileFeedbackPreferences(storage("{not json"))).toEqual({hapticsEnabled: true, soundEnabled: false});
    expect(readMobileFeedbackPreferences(storage('{"hapticsEnabled":"yes","soundEnabled":1}')))
      .toEqual({hapticsEnabled: true, soundEnabled: false});
  });

  it("does not break editing when storage is blocked", () => {
    const blocked = {
      getItem: (_key: string): string | null => {throw new Error("SecurityError");},
      setItem: (_key: string, _value: string): void => {throw new Error("QuotaExceededError");},
    };
    expect(readMobileFeedbackPreferences(blocked)).toEqual({hapticsEnabled: true, soundEnabled: false});
    expect(writeMobileFeedbackPreferences({hapticsEnabled: false, soundEnabled: false}, blocked)).toBe(false);
  });
});
