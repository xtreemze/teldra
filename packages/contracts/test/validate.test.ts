import { describe, expect, it } from "vitest";
import { parseTwin, SchemaValidationError, validateTwin } from "../src/index.js";

const validTwin = {
  schemaVersion: "0.1.0",
  building: {
    ifcSchema: "IFC4",
    refs: [
      {
        id: "space:living",
        ifcGlobalId: "3ZYNKvi3P3FvKPBGP9UP7n",
        kind: "space",
      },
    ],
  },
  devices: [],
  bindings: [],
};

describe("twin schema validation", () => {
  it("accepts a structurally valid serialized twin", () => {
    expect(validateTwin(validTwin)).toBe(true);
    expect(parseTwin(validTwin)).toEqual(validTwin);
  });

  it("rejects data outside the versioned schema", () => {
    const invalid = {
      ...validTwin,
      schemaVersion: "9.9.9",
    };

    expect(validateTwin(invalid)).toBe(false);
    expect(() => parseTwin(invalid)).toThrow(SchemaValidationError);
  });

  it("rejects renderer state in canonical serialization", () => {
    const invalid = {
      ...validTwin,
      babylonScene: {},
    };

    expect(() => parseTwin(invalid)).toThrow(SchemaValidationError);
  });
});
