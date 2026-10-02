import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import type { TeldraProjectManifest } from "./generated/project.js";
import { projectSchema, twinSchema } from "./generated/schemas.js";
import type { TeldraTwin } from "./generated/twin.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});

const twinValidator = ajv.compile<TeldraTwin>(twinSchema);
const projectValidator = ajv.compile<TeldraProjectManifest>(projectSchema);

export class SchemaValidationError extends Error {
  readonly errors: readonly ErrorObject[];

  constructor(kind: string, errors: readonly ErrorObject[]) {
    super(`Invalid Teldra ${kind}: ${ajv.errorsText(errors, { separator: "; " })}`);
    this.name = "SchemaValidationError";
    this.errors = errors;
  }
}

export function validateTwin(value: unknown): value is TeldraTwin {
  return twinValidator(value);
}

export function parseTwin(value: unknown): TeldraTwin {
  if (!twinValidator(value)) {
    throw new SchemaValidationError("twin", twinValidator.errors ?? []);
  }
  return value;
}

export function validateProjectManifest(value: unknown): value is TeldraProjectManifest {
  return projectValidator(value);
}

export function parseProjectManifest(value: unknown): TeldraProjectManifest {
  if (!projectValidator(value)) {
    throw new SchemaValidationError("project manifest", projectValidator.errors ?? []);
  }
  return value;
}
