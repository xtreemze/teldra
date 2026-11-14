import { describe, expect, it } from "vitest";
import { parseWallDraftIntent, serializeWallDraftIntent } from "../src/wall-draft-intent.js";

const wall = {
  start: [0, 0] as const,
  end: [4, 0] as const,
  thicknessMetres: .2,
  heightMetres: 2.6,
};

describe("wall draft proposal review contract", () => {
  it("round-trips the same versioned JSON contract used by the IFC archive CLI", () => {
    const result = parseWallDraftIntent(serializeWallDraftIntent(wall));
    expect(result.wall).toEqual(wall);
    expect(result.coordinateFrame).toBe("ifc-world-metres-z-up");
    expect(result.operation).toBe("CreateWall");
    expect(wall).toEqual({
      start: [0, 0], end: [4, 0], thicknessMetres: .2, heightMetres: 2.6,
    });
  });

  it("rejects unsupported operations, frames, or versions", () => {
    const baseline = JSON.parse(serializeWallDraftIntent(wall)) as Record<string, unknown>;
    for (const patch of [
      {operation: "DeleteWall"},
      {operation: "EditWall"},
      {coordinateFrame: "camera-pixels"},
      {format: "teldra-wall-draft-v2"},
    ]) {
      expect(() => parseWallDraftIntent(JSON.stringify({...baseline, ...patch})))
        .toThrow(/Unsupported/);
    }
  });

  it("rejects malformed and unsafe geometry without coercion", () => {
    const baseline = JSON.parse(serializeWallDraftIntent(wall)) as Record<string, unknown>;
    for (const geometry of [
      {...wall, start: [true, 0]},
      {...wall, start: [0]},
      {...wall, start: ["0", 0]},
      {...wall, end: [0, 0]},
      {...wall, thicknessMetres: -1},
      {...wall, heightMetres: 101},
      {...wall, extra: "ignored"},
    ]) {
      expect(() => parseWallDraftIntent(JSON.stringify({...baseline, wall: geometry}))).toThrow();
    }
    expect(() => parseWallDraftIntent("{")).toThrow(/valid JSON/);
    expect(() => parseWallDraftIntent("null")).toThrow(/object/);
  });

  it("bounds agent-controlled intent size", () => {
    const payload = JSON.parse(serializeWallDraftIntent(wall)) as Record<string, unknown>;
    payload.warning = "x".repeat(65_536);
    expect(() => parseWallDraftIntent(JSON.stringify(payload))).toThrow(/64 KiB/);
  });
});
