import { describe, expect, it } from "vitest";
import { studioIconGroups, studioIconNames, studioIconPaths } from "./StudioIcon";

describe("Teldra Studio iconography contract", () => {
  it("has only non-empty, path-based, self-contained glyphs", () => {
    expect(studioIconNames.length).toBeGreaterThanOrEqual(50);
    expect(new Set(studioIconNames).size).toBe(studioIconNames.length);
    for (const [name, path] of Object.entries(studioIconPaths)) {
      expect(name).toMatch(/^[a-z][a-zA-Z]+$/);
      expect(path).toMatch(/^M[\d\s,.-]+|^m[\d\s,.-]+/);
      expect(path).not.toContain("url(");
      expect(path).not.toContain("<");
    }
  });
  it("provides one named catalog placement for every icon", () => {
    const all = Object.values(studioIconGroups).flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...studioIconNames].sort());
  });
});
