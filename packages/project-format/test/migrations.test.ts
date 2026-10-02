import { describe, expect, it } from "vitest";
import {
  MigrationRegistry,
  ProjectFormatError,
  ProjectFormatMigrationError,
  parseTwinProject,
} from "../src/index.js";

describe("MigrationRegistry", () => {
  it("returns current-version documents unchanged", () => {
    const registry = new MigrationRegistry("version", "2", []);
    const current = { version: "2", value: 1 };

    expect(registry.migrate(current)).toBe(current);
  });

  it("applies an explicit migration path in order", () => {
    const registry = new MigrationRegistry("version", "3", [
      {
        from: "1",
        to: "2",
        migrate: (value) => ({ ...value, version: "2", first: true }),
      },
      {
        from: "2",
        to: "3",
        migrate: (value) => ({ ...value, version: "3", second: true }),
      },
    ]);

    expect(registry.migrate({ version: "1" })).toEqual({
      version: "3",
      first: true,
      second: true,
    });
  });

  it("rejects documents with no registered path to the current version", () => {
    const registry = new MigrationRegistry("version", "2", []);

    expect(() => registry.migrate({ version: "1" })).toThrow(
      ProjectFormatMigrationError,
    );
  });

  it("reports unsupported twin versions as typed project-format failures", () => {
    expect(() =>
      parseTwinProject({
        schemaVersion: "0.0.1",
        building: { ifcSchema: "IFC4", refs: [] },
        devices: [],
        bindings: [],
      }),
    ).toThrow(ProjectFormatError);

    try {
      parseTwinProject({
        schemaVersion: "0.0.1",
        building: { ifcSchema: "IFC4", refs: [] },
        devices: [],
        bindings: [],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectFormatError);
      expect((error as ProjectFormatError).issues[0]?.source).toBe("migration");
    }
  });
});
