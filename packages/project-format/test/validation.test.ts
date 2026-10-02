import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import {
  ProjectFormatError,
  parseTwinProject,
  validateProjectManifest,
  validateTwinProject,
} from "../src/index.js";

describe("Teldra serialized authority", () => {
  it("accepts the canonical golden twin fixture", () => {
    const result = validateTwinProject(goldenTwin);

    expect(result.valid).toBe(true);

    if (result.valid) {
      expect(result.value.devices[0]?.id).toBe("device:living-room-floor-lamp");
    }
  });

  it("rejects structurally unknown serialized fields", () => {
    const candidate = {
      ...goldenTwin,
      renderer: "babylon",
    };

    const result = validateTwinProject(candidate);

    expect(result.valid).toBe(false);

    if (!result.valid) {
      expect(result.issues.some((issue) => issue.source === "schema")).toBe(true);
    }
  });

  it("rejects canonical identity collisions after schema validation", () => {
    const candidate = structuredClone(goldenTwin);
    candidate.devices[0]!.id = candidate.building.refs[0]!.id;

    const result = validateTwinProject(candidate);

    expect(result.valid).toBe(false);

    if (!result.valid) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "integrity",
            message: expect.stringContaining("Duplicate canonical identity"),
          }),
        ]),
      );
    }
  });

  it("throws a typed format error when parsing invalid twin data", () => {
    expect(() => parseTwinProject({})).toThrow(ProjectFormatError);
  });

  it("rejects malformed artifact hashes in project manifests", () => {
    const result = validateProjectManifest({
      formatVersion: "0.1.0",
      building: {
        path: "building.ifc",
        sha256: "not-a-sha256",
      },
      twin: {
        path: "twin.json",
        sha256: "0".repeat(64),
      },
    });

    expect(result.valid).toBe(false);
  });
});
