export type VersionedDocument = Readonly<Record<string, unknown>>;

export interface MigrationStep {
  readonly from: string;
  readonly to: string;
  migrate(value: VersionedDocument): VersionedDocument;
}

export class ProjectFormatMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectFormatMigrationError";
  }
}

export class MigrationRegistry {
  readonly #versionField: string;
  readonly #currentVersion: string;
  readonly #steps: ReadonlyMap<string, MigrationStep>;

  constructor(
    versionField: string,
    currentVersion: string,
    steps: readonly MigrationStep[],
  ) {
    this.#versionField = versionField;
    this.#currentVersion = currentVersion;

    const bySource = new Map<string, MigrationStep>();
    for (const step of steps) {
      if (bySource.has(step.from)) {
        throw new ProjectFormatMigrationError(
          `Duplicate migration source version "${step.from}".`,
        );
      }
      bySource.set(step.from, step);
    }

    this.#steps = bySource;
  }

  migrate(value: unknown): unknown {
    if (!isRecord(value)) {
      return value;
    }

    const rawVersion = value[this.#versionField];
    if (typeof rawVersion !== "string" || rawVersion === this.#currentVersion) {
      return value;
    }

    let current = value;
    let version = rawVersion;
    const visited = new Set<string>();

    while (version !== this.#currentVersion) {
      if (visited.has(version)) {
        throw new ProjectFormatMigrationError(
          `Migration cycle detected at version "${version}".`,
        );
      }
      visited.add(version);

      const step = this.#steps.get(version);
      if (step === undefined) {
        throw new ProjectFormatMigrationError(
          `No migration path from "${rawVersion}" to "${this.#currentVersion}".`,
        );
      }

      current = step.migrate(current);
      version = step.to;
    }

    return current;
  }
}

export const CURRENT_TWIN_SCHEMA_VERSION = "0.1.0";
export const CURRENT_PROJECT_FORMAT_VERSION = "0.1.0";

export const twinMigrationRegistry = new MigrationRegistry(
  "schemaVersion",
  CURRENT_TWIN_SCHEMA_VERSION,
  [],
);

export const projectMigrationRegistry = new MigrationRegistry(
  "formatVersion",
  CURRENT_PROJECT_FORMAT_VERSION,
  [],
);

function isRecord(value: unknown): value is VersionedDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
