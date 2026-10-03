import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import projectSchema from "@teldra/schemas/project" with { type: "json" };
import twinSchema from "@teldra/schemas/twin" with { type: "json" };
import type { TeldraProjectManifest as SerializedProjectManifest } from "@teldra/schemas/types/project";
import {
  TwinIntegrityError,
  assertTwinIntegrity,
  type TwinProject,
} from "@teldra/domain";
import {
  ProjectFormatMigrationError,
  projectMigrationRegistry,
  twinMigrationRegistry,
} from "./migrations.js";

export {
  CURRENT_PROJECT_FORMAT_VERSION,
  CURRENT_TWIN_SCHEMA_VERSION,
  MigrationRegistry,
  ProjectFormatMigrationError,
  projectMigrationRegistry,
  twinMigrationRegistry,
  type MigrationStep,
} from "./migrations.js";

export type ProjectArtifact = SerializedProjectManifest["building"];
export type TeldraProjectManifest = SerializedProjectManifest;

export interface ValidationIssue {
  source: "schema" | "integrity" | "migration";
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | {
      valid: true;
      value: T;
      issues: readonly [];
    }
  | {
      valid: false;
      issues: readonly ValidationIssue[];
    };

export class ProjectFormatError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ProjectFormatError";
    this.issues = issues;
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});

const validateTwinStructure: ValidateFunction<TwinProject> =
  ajv.compile<TwinProject>(twinSchema);
const validateProjectStructure: ValidateFunction<TeldraProjectManifest> =
  ajv.compile<TeldraProjectManifest>(projectSchema);

export function validateTwinProject(value: unknown): ValidationResult<TwinProject> {
  if (!validateTwinStructure(value)) {
    return {
      valid: false,
      issues: schemaIssues(validateTwinStructure.errors),
    };
  }

  try {
    assertTwinIntegrity(value);
  } catch (error) {
    if (error instanceof TwinIntegrityError) {
      return {
        valid: false,
        issues: [
          {
            source: "integrity",
            path: "",
            message: error.message,
          },
        ],
      };
    }

    throw error;
  }

  return {
    valid: true,
    value,
    issues: [],
  };
}

export function parseTwinProject(value: unknown): TwinProject {
  return parseMigrated(
    value,
    (candidate) => twinMigrationRegistry.migrate(candidate),
    validateTwinProject,
    "Invalid Teldra twin document.",
    "/schemaVersion",
  );
}

export function validateProjectManifest(
  value: unknown,
): ValidationResult<TeldraProjectManifest> {
  if (!validateProjectStructure(value)) {
    return {
      valid: false,
      issues: schemaIssues(validateProjectStructure.errors),
    };
  }

  return {
    valid: true,
    value,
    issues: [],
  };
}

export function parseProjectManifest(value: unknown): TeldraProjectManifest {
  return parseMigrated(
    value,
    (candidate) => projectMigrationRegistry.migrate(candidate),
    validateProjectManifest,
    "Invalid Teldra project manifest.",
    "/formatVersion",
  );
}

function parseMigrated<T>(
  value: unknown,
  migrate: (value: unknown) => unknown,
  validate: (value: unknown) => ValidationResult<T>,
  message: string,
  versionPath: string,
): T {
  let migrated: unknown;

  try {
    migrated = migrate(value);
  } catch (error) {
    if (error instanceof ProjectFormatMigrationError) {
      throw new ProjectFormatError(message, [
        {
          source: "migration",
          path: versionPath,
          message: error.message,
        },
      ]);
    }

    throw error;
  }

  const result = validate(migrated);

  if (!result.valid) {
    throw new ProjectFormatError(message, result.issues);
  }

  return result.value;
}

function schemaIssues(
  errors: readonly ErrorObject[] | null | undefined,
): readonly ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    source: "schema",
    path: error.instancePath,
    message: error.message ?? "JSON Schema validation failed.",
  }));
}

export * from "./persistence.js";
