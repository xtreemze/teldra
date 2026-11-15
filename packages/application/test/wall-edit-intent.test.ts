import { describe, expect, it } from "vitest";
import {
  parseExistingWallEditIntent,
  serializeExistingWallEditIntent,
} from "../src/wall-draft-intent.js";

const wall = {
  start: [1, 2] as const,
  end: [5, 2] as const,
  thicknessMetres: 0.2,
  heightMetres: 2.6,
};
const guid = "0".repeat(22);

describe("selected existing IFC wall edit handoff", () => {
  it("roundtrips explicit target and geometry without changing source", () => {
    const serialized = serializeExistingWallEditIntent(wall, guid);
    const parsed = parseExistingWallEditIntent(serialized);
    expect(parsed.operation).toBe("EditWall");
    expect(parsed.targetIfcGlobalId).toBe(guid);
    expect(parsed.wall).toEqual(wall);
    expect(parsed.wall).not.toBe(wall);
    expect(parsed.format).toBe("teldra-wall-edit-v1");
  });
  it("rejects unsupported edit targets and commands", () => {
    const baseline = JSON.parse(serializeExistingWallEditIntent(wall, guid)) as Record<string, unknown>;
    for (const patch of [
      { targetIfcGlobalId: "arbitrary" },
      { targetIfcGlobalId: "z".repeat(23) },
      { operation: "DeleteWall" },
      { operation: "CreateWall" },
      { coordinateFrame: "screen-pixels" },
      { format: "teldra-wall-draft-v1" },
      { otherCommand: "DeleteAll" },
      { wall: {...wall, start: [true, 1]} },
      { wall: {...wall, thicknessMetres: -1} },
    ]) {
      expect(() => parseExistingWallEditIntent(JSON.stringify({ ...baseline, ...patch }))).toThrow();
    }
    expect(() => serializeExistingWallEditIntent(wall, "wrong")).toThrow(/GlobalId/);
  });
  it("refuses oversized and malformed files", () => {
    const baseline = JSON.parse(serializeExistingWallEditIntent(wall, guid)) as Record<string, unknown>;
    expect(() => parseExistingWallEditIntent("{")).toThrow(/valid JSON/);
    expect(() => parseExistingWallEditIntent(JSON.stringify({...baseline, warning:"x".repeat(70_000)}))).toThrow(/64 KiB/);
  });
});
