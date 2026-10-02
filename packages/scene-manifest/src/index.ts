import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import sceneSchema from "@teldra/schemas/scene" with { type: "json" };
import type { TeldraSceneManifest } from "@teldra/schemas/types/scene";

export type { TeldraSceneManifest } from "@teldra/schemas/types/scene";

export interface SceneManifestIssue {
  source: "schema" | "integrity";
  path: string;
  message: string;
}

export type SceneManifestValidationResult =
  | {
      valid: true;
      value: TeldraSceneManifest;
      issues: readonly [];
    }
  | {
      valid: false;
      issues: readonly SceneManifestIssue[];
    };

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});

const validateStructure: ValidateFunction<TeldraSceneManifest> =
  ajv.compile<TeldraSceneManifest>(sceneSchema);

export function validateSceneManifest(
  value: unknown,
): SceneManifestValidationResult {
  if (!validateStructure(value)) {
    return {
      valid: false,
      issues: schemaIssues(validateStructure.errors),
    };
  }

  const integrityIssues = validateIntegrity(value);

  if (integrityIssues.length > 0) {
    return {
      valid: false,
      issues: integrityIssues,
    };
  }

  return {
    valid: true,
    value,
    issues: [],
  };
}

export function parseSceneManifest(value: unknown): TeldraSceneManifest {
  const result = validateSceneManifest(value);

  if (!result.valid) {
    throw new SceneManifestError("Invalid Teldra scene manifest.", result.issues);
  }

  return result.value;
}

export class SceneManifestError extends Error {
  readonly issues: readonly SceneManifestIssue[];

  constructor(message: string, issues: readonly SceneManifestIssue[]) {
    super(message);
    this.name = "SceneManifestError";
    this.issues = issues;
  }
}

function validateIntegrity(
  manifest: TeldraSceneManifest,
): readonly SceneManifestIssue[] {
  const issues: SceneManifestIssue[] = [];
  const nodeKeys = new Set<string>();

  for (const [index, node] of manifest.nodes.entries()) {
    if (nodeKeys.has(node.nodeKey)) {
      issues.push({
        source: "integrity",
        path: `/nodes/${index}/nodeKey`,
        message: `Duplicate scene node key "${node.nodeKey}".`,
      });
    }

    nodeKeys.add(node.nodeKey);

    if (node.kind === "building" && node.ifcGlobalId === undefined) {
      issues.push({
        source: "integrity",
        path: `/nodes/${index}/ifcGlobalId`,
        message: "Building scene nodes must preserve their IFC GlobalId.",
      });
    }

    if (node.kind !== "building" && node.ifcGlobalId !== undefined) {
      issues.push({
        source: "integrity",
        path: `/nodes/${index}/ifcGlobalId`,
        message: "Only building scene nodes may carry IFC GlobalId identity.",
      });
    }
  }

  return issues;
}

function schemaIssues(
  errors: readonly ErrorObject[] | null | undefined,
): readonly SceneManifestIssue[] {
  return (errors ?? []).map((error) => ({
    source: "schema",
    path: error.instancePath,
    message: error.message ?? "JSON Schema validation failed.",
  }));
}
