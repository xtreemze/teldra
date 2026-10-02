import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import appearanceSchema from "@teldra/schemas/appearance" with { type: "json" };
import type { TeldraAppearanceManifest } from "@teldra/schemas/types/appearance";

export type { TeldraAppearanceManifest } from "@teldra/schemas/types/appearance";

export interface AppearanceManifestIssue {
  source: "schema" | "integrity";
  path: string;
  message: string;
}

export type AppearanceManifestValidationResult =
  | {
      valid: true;
      value: TeldraAppearanceManifest;
      issues: readonly [];
    }
  | {
      valid: false;
      issues: readonly AppearanceManifestIssue[];
    };

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateStructure: ValidateFunction<TeldraAppearanceManifest> =
  ajv.compile<TeldraAppearanceManifest>(appearanceSchema);

export function validateAppearanceManifest(
  value: unknown,
): AppearanceManifestValidationResult {
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

export function parseAppearanceManifest(value: unknown): TeldraAppearanceManifest {
  const result = validateAppearanceManifest(value);
  if (!result.valid) {
    throw new AppearanceManifestError(
      "Invalid Teldra appearance manifest.",
      result.issues,
    );
  }

  return result.value;
}

export class AppearanceManifestError extends Error {
  readonly issues: readonly AppearanceManifestIssue[];

  constructor(message: string, issues: readonly AppearanceManifestIssue[]) {
    super(message);
    this.name = "AppearanceManifestError";
    this.issues = issues;
  }
}

function validateIntegrity(
  manifest: TeldraAppearanceManifest,
): readonly AppearanceManifestIssue[] {
  const issues: AppearanceManifestIssue[] = [];
  const materialKeys = new Set<string>();

  for (const [materialIndex, material] of manifest.materials.entries()) {
    if (materialKeys.has(material.materialKey)) {
      issues.push({
        source: "integrity",
        path: `/materials/${materialIndex}/materialKey`,
        message: `Duplicate material key "${material.materialKey}".`,
      });
    }
    materialKeys.add(material.materialKey);

    const semantics = new Set<string>();
    const nodeKeys = new Set<string>();

    for (const [nodeIndex, nodeKey] of material.nodeKeys.entries()) {
      if (nodeKeys.has(nodeKey)) {
        issues.push({
          source: "integrity",
          path: `/materials/${materialIndex}/nodeKeys/${nodeIndex}`,
          message: `Duplicate node key "${nodeKey}" in material binding.`,
        });
      }
      nodeKeys.add(nodeKey);
    }

    for (const [textureIndex, texture] of material.textures.entries()) {
      if (semantics.has(texture.semantic)) {
        issues.push({
          source: "integrity",
          path: `/materials/${materialIndex}/textures/${textureIndex}/semantic`,
          message: `Duplicate texture semantic "${texture.semantic}" for one material.`,
        });
      }
      semantics.add(texture.semantic);

      if (texture.uvSet !== manifest.profile.primaryUvSet) {
        issues.push({
          source: "integrity",
          path: `/materials/${materialIndex}/textures/${textureIndex}/uvSet`,
          message: "Material textures must use the declared primary UV set.",
        });
      }

      const hasPath = texture.assetPath !== undefined;
      const hasHash = texture.assetSha256 !== undefined;
      if (hasPath !== hasHash) {
        issues.push({
          source: "integrity",
          path: `/materials/${materialIndex}/textures/${textureIndex}`,
          message: "External texture bindings require both assetPath and assetSha256.",
        });
      }
    }
  }

  return issues;
}

function schemaIssues(
  errors: readonly ErrorObject[] | null | undefined,
): readonly AppearanceManifestIssue[] {
  return (errors ?? []).map((error) => ({
    source: "schema",
    path: error.instancePath,
    message: error.message ?? "JSON Schema validation failed.",
  }));
}
