import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import diagnosticEventSchema from "@teldra/schemas/diagnostic-event" with { type: "json" };
import supportBundleSchema from "@teldra/schemas/support-bundle" with { type: "json" };

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export type DiagnosticSubsystem =
  | "application"
  | "project-format"
  | "ifc"
  | "sh3d-import"
  | "projection"
  | "scene-export"
  | "babylon"
  | "deck"
  | "blender"
  | "bake"
  | "home-assistant"
  | "live-state"
  | "persistence"
  | "security"
  | "unknown";

export type DiagnosticSensitivity =
  | "public"
  | "project-private"
  | "secret";

export type DiagnosticJson =
  | null
  | boolean
  | number
  | string
  | readonly DiagnosticJson[]
  | { readonly [key: string]: DiagnosticJson };

export interface DiagnosticField {
  readonly sensitivity: DiagnosticSensitivity;
  readonly value: DiagnosticJson;
}

export interface DiagnosticEvent {
  readonly schemaVersion: "0.1.0";
  readonly eventId: string;
  readonly timestamp: string;
  readonly level: DiagnosticLevel;
  readonly subsystem: DiagnosticSubsystem;
  readonly code: string;
  readonly correlationId: string;
  readonly operationId?: string;
  readonly userMessage?: string;
  readonly detail?: string;
  readonly fields: Readonly<Record<string, DiagnosticField>>;
}

export interface SupportBundleApplication {
  readonly version: string;
  readonly sourceCommit: string;
  readonly toolchainManifestSha256: string;
}

export interface SupportBundleEnvironment {
  readonly runtime: string;
  readonly browser?: string;
  readonly os?: string;
  readonly renderBackend: string;
}

export interface SupportBundleProject {
  readonly fingerprint: string;
  readonly formatVersion?: string;
}

export interface SupportBundleAdapter {
  readonly kind: string;
  readonly status:
    | "connected"
    | "disconnected"
    | "degraded"
    | "unavailable";
  readonly capabilities?: readonly string[];
}

export interface SupportBundle {
  readonly schemaVersion: "0.1.0";
  readonly createdAt: string;
  readonly application: SupportBundleApplication;
  readonly environment: SupportBundleEnvironment;
  readonly project: SupportBundleProject;
  readonly adapters: readonly SupportBundleAdapter[];
  readonly events: readonly DiagnosticEvent[];
}

export interface SupportBundleInput {
  readonly createdAt: string;
  readonly application: SupportBundleApplication;
  readonly environment: SupportBundleEnvironment;
  readonly projectFingerprint: string;
  readonly projectFormatVersion?: string;
  readonly adapters?: readonly SupportBundleAdapter[];
  readonly events: readonly DiagnosticEvent[];
  readonly pseudonymizationSalt: string;
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly valid: true; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  formats: {
    "date-time": true,
  },
});

ajv.addSchema(diagnosticEventSchema);

const validateEventStructure: ValidateFunction<DiagnosticEvent> =
  ajv.compile<DiagnosticEvent>(diagnosticEventSchema);
const validateBundleStructure: ValidateFunction<SupportBundle> =
  ajv.compile<SupportBundle>(supportBundleSchema);

const SECRET_FIELD_NAME =
  /authorization|token|password|passwd|secret|private[-_.]?key|cookie|api[-_.]?key/i;

export function validateDiagnosticEvent(value: unknown): ValidationResult {
  if (!validateEventStructure(value)) {
    return {
      valid: false,
      issues: schemaIssues(validateEventStructure.errors),
    };
  }

  const issues: ValidationIssue[] = [];
  for (const [name, field] of Object.entries(value.fields)) {
    if (SECRET_FIELD_NAME.test(name) && field.sensitivity !== "secret") {
      issues.push({
        path: `/fields/${escapeJsonPointer(name)}/sensitivity`,
        message:
          "Fields with secret-like names must be classified as secret.",
      });
    }
  }

  return issues.length === 0
    ? { valid: true, issues: [] }
    : { valid: false, issues };
}

export function validateSupportBundle(value: unknown): ValidationResult {
  if (!validateBundleStructure(value)) {
    return {
      valid: false,
      issues: schemaIssues(validateBundleStructure.errors),
    };
  }

  const issues: ValidationIssue[] = [];

  for (const [index, event] of value.events.entries()) {
    const result = validateDiagnosticEvent(event);
    if (!result.valid) {
      issues.push(
        ...result.issues.map((issue) => ({
          path: `/events/${index}${issue.path}`,
          message: issue.message,
        })),
      );
    }
  }

  return issues.length === 0
    ? { valid: true, issues: [] }
    : { valid: false, issues };
}

export function createSupportBundle(input: SupportBundleInput): SupportBundle {
  if (input.pseudonymizationSalt.length < 16) {
    throw new Error(
      "Support-bundle pseudonymization salt must be at least 16 characters.",
    );
  }

  const events = input.events.map((event) =>
    sanitizeDiagnosticEvent(event, input.pseudonymizationSalt),
  );

  const bundle: SupportBundle = {
    schemaVersion: "0.1.0",
    createdAt: input.createdAt,
    application: input.application,
    environment: input.environment,
    project: {
      fingerprint: pseudonymize(
        input.projectFingerprint,
        input.pseudonymizationSalt,
      ),
      ...(input.projectFormatVersion === undefined
        ? {}
        : { formatVersion: input.projectFormatVersion }),
    },
    adapters: input.adapters ?? [],
    events,
  };

  const validation = validateSupportBundle(bundle);
  if (!validation.valid) {
    throw new Error(
      `Invalid support bundle: ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  return bundle;
}

export function sanitizeDiagnosticEvent(
  event: DiagnosticEvent,
  salt: string,
): DiagnosticEvent {
  const validation = validateDiagnosticEvent(event);
  if (!validation.valid) {
    throw new Error(
      `Invalid diagnostic event: ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  return {
    ...event,
    eventId: pseudonymize(event.eventId, salt),
    correlationId: pseudonymize(event.correlationId, salt),
    ...(event.operationId === undefined
      ? {}
      : { operationId: pseudonymize(event.operationId, salt) }),
    fields: Object.fromEntries(
      Object.entries(event.fields).map(([name, field]) => [
        name,
        sanitizeField(field, salt),
      ]),
    ),
  };
}

export function diagnosticField(
  sensitivity: DiagnosticSensitivity,
  value: DiagnosticJson,
): DiagnosticField {
  return { sensitivity, value };
}

export function publicField(value: DiagnosticJson): DiagnosticField {
  return diagnosticField("public", value);
}

export function privateField(value: DiagnosticJson): DiagnosticField {
  return diagnosticField("project-private", value);
}

export function secretField(value: DiagnosticJson): DiagnosticField {
  return diagnosticField("secret", value);
}

function sanitizeField(
  field: DiagnosticField,
  salt: string,
): DiagnosticField {
  switch (field.sensitivity) {
    case "public":
      return field;
    case "project-private":
      return {
        sensitivity: "project-private",
        value: pseudonymize(stableJson(field.value), salt),
      };
    case "secret":
      return {
        sensitivity: "secret",
        value: "<redacted>",
      };
  }
}

function pseudonymize(value: string, salt: string): string {
  // FNV-1a 64-bit implemented with BigInt is deterministic across supported
  // JS runtimes and avoids introducing Node/browser crypto dependencies here.
  let hash = 0xcbf29ce484222325n;

  for (const char of `${salt}\u0000${value}`) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }

  return `p:${hash.toString(16).padStart(16, "0")}`;
}

function stableJson(value: DiagnosticJson): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${stableJson(item)}`,
    )
    .join(",")}}`;
}

function schemaIssues(
  errors: readonly ErrorObject[] | null | undefined,
): readonly ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath,
    message: error.message ?? "JSON Schema validation failed.",
  }));
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
