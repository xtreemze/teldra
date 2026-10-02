import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import projectSchema from "@teldra/schemas/project" with { type: "json" };
import twinSchema from "@teldra/schemas/twin" with { type: "json" };
import {
  TwinIntegrityError,
  assertTwinIntegrity,
  type TwinProject,
} from "@teldra/domain";

export interface ProjectArtifact {
  path: string;
  sha256: string;
}

export interface TeldraProjectManifest {
  formatVersion: "0.1.0";
  building: ProjectArtifact;
  twin: ProjectArtifact;
  derived?: readonly ProjectArtifact[];
}

export interface ValidationIssue {
  source: "schema" | "integrity";
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

const validateTwinStructure = ajv.compile(twinSchema);
const validateProjectStructure = ajv.compile(projectSchema);

export function validateTwinProject(value: unknown): ValidationResult<TwinProject> {
  if (!validateTwinStructure(value)) {
    return {
      valid: false,
      issues: schemaIssues(validateTwinStructure.errors),
    };
  }

  try {
    assertTwinIntegrity(value as TwinProject);
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
    value: value as TwinProject,
    issues: [],
  };
}

export function parseTwinProject(value: unknown): TwinProject {
  const result = validateTwinProject(value);

  if (!result.valid) {
    throw new ProjectFormatError("Invalid Teldra twin document.", result.issues);
  }

  return result.value;
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
    value: value as TeldraProjectManifest,
    issues: [],
  };
}

export function parseProjectManifest(value: unknown): TeldraProjectManifest {
  const result = validateProjectManifest(value);

  if (!result.valid) {
    throw new ProjectFormatError("Invalid Teldra project manifest.", result.issues);
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
