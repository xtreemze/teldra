import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import lightingSchema from "@teldra/schemas/lighting" with { type: "json" };
import type { TeldraLightingManifest } from "@teldra/schemas/types/lighting";

export type { TeldraLightingManifest } from "@teldra/schemas/types/lighting";

export interface LightingManifestIssue {
  source: "schema" | "integrity";
  path: string;
  message: string;
}

export type LightingManifestValidationResult =
  | {
      valid: true;
      value: TeldraLightingManifest;
      issues: readonly [];
    }
  | {
      valid: false;
      issues: readonly LightingManifestIssue[];
    };

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateStructure: ValidateFunction<TeldraLightingManifest> =
  ajv.compile<TeldraLightingManifest>(lightingSchema);

export function validateLightingManifest(
  value: unknown,
): LightingManifestValidationResult {
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

export function parseLightingManifest(value: unknown): TeldraLightingManifest {
  const result = validateLightingManifest(value);
  if (!result.valid) {
    throw new LightingManifestError(
      "Invalid Teldra lighting manifest.",
      result.issues,
    );
  }

  return result.value;
}

export class LightingManifestError extends Error {
  readonly issues: readonly LightingManifestIssue[];

  constructor(message: string, issues: readonly LightingManifestIssue[]) {
    super(message);
    this.name = "LightingManifestError";
    this.issues = issues;
  }
}

function validateIntegrity(
  manifest: TeldraLightingManifest,
): readonly LightingManifestIssue[] {
  const issues: LightingManifestIssue[] = [];
  const basisIds = new Set<string>();
  const assignedFixtureLights = new Set<string>();

  for (const [basisIndex, basis] of manifest.radianceBases.entries()) {
    if (basisIds.has(basis.basisId)) {
      issues.push({
        source: "integrity",
        path: `/radianceBases/${basisIndex}/basisId`,
        message: `Duplicate radiance basis ID "${basis.basisId}".`,
      });
    }
    basisIds.add(basis.basisId);

    const nodeKeys = new Set<string>();
    for (const [nodeIndex, nodeKey] of basis.nodeKeys.entries()) {
      if (nodeKeys.has(nodeKey)) {
        issues.push({
          source: "integrity",
          path: `/radianceBases/${basisIndex}/nodeKeys/${nodeIndex}`,
          message: `Duplicate node key "${nodeKey}" in radiance basis.`,
        });
      }
      nodeKeys.add(nodeKey);
    }

    if (basis.kind === "fixture-group") {
      if (basis.lightIds.length === 0) {
        issues.push({
          source: "integrity",
          path: `/radianceBases/${basisIndex}/lightIds`,
          message: "Fixture-group radiance bases require at least one canonical light ID.",
        });
      }

      for (const [lightIndex, lightId] of basis.lightIds.entries()) {
        if (assignedFixtureLights.has(lightId)) {
          issues.push({
            source: "integrity",
            path: `/radianceBases/${basisIndex}/lightIds/${lightIndex}`,
            message: `Canonical light "${lightId}" belongs to more than one fixture-group basis.`,
          });
        }
        assignedFixtureLights.add(lightId);
      }
    } else if (basis.lightIds.length > 0) {
      issues.push({
        source: "integrity",
        path: `/radianceBases/${basisIndex}/lightIds`,
        message: "Ambient and daylight bases must not bind canonical fixture lights.",
      });
    }
  }

  const probeIds = new Set<string>();
  for (const [probeIndex, probe] of manifest.reflectionProbes.entries()) {
    if (probeIds.has(probe.probeId)) {
      issues.push({
        source: "integrity",
        path: `/reflectionProbes/${probeIndex}/probeId`,
        message: `Duplicate reflection probe ID "${probe.probeId}".`,
      });
    }
    probeIds.add(probe.probeId);

    const stateIds = new Set<string>();
    for (const [stateIndex, state] of probe.states.entries()) {
      if (stateIds.has(state.stateId)) {
        issues.push({
          source: "integrity",
          path: `/reflectionProbes/${probeIndex}/states/${stateIndex}/stateId`,
          message: `Duplicate reflection state ID "${state.stateId}" in probe.`,
        });
      }
      stateIds.add(state.stateId);
    }
  }

  return issues;
}

function schemaIssues(
  errors: readonly ErrorObject[] | null | undefined,
): readonly LightingManifestIssue[] {
  return (errors ?? []).map((error) => ({
    source: "schema",
    path: error.instancePath,
    message: error.message ?? "JSON Schema validation failed.",
  }));
}
