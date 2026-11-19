/**
 * Minimal JSON-Schema subset used by agent tools. The same schema objects are published to
 * agents (WebMCP `inputSchema`) and enforced on every call, so documentation cannot drift from
 * behaviour. Supported keywords: type, enum, const, properties, required, additionalProperties,
 * items, minItems, maxItems, minimum, maximum, minLength, maxLength, oneOf.
 */
export interface AgentJsonSchema {
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  readonly description?: string;
  readonly enum?: readonly (string | number)[];
  readonly const?: string | number | boolean;
  readonly properties?: Readonly<Record<string, AgentJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: AgentJsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly oneOf?: readonly AgentJsonSchema[];
}

/** Returns human-readable violations; empty when the value conforms. */
export function validateAgentSchema(schema: AgentJsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((option) => validateAgentSchema(option, value, path).length === 0);
    if (matches.length !== 1) errors.push(`${path}: must match exactly one allowed shape (matched ${matches.length}).`);
    return errors;
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}.`);
  if (schema.enum && !schema.enum.includes(value as string | number)) errors.push(`${path}: must be one of ${schema.enum.join(", ")}.`);
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [...errors, `${path}: must be an object.`];
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (record[key] === undefined) errors.push(`${path}.${key}: is required.`);
      for (const [key, item] of Object.entries(record)) {
        const child = schema.properties?.[key];
        if (child) { if (item !== undefined) errors.push(...validateAgentSchema(child, item, `${path}.${key}`)); }
        else if (schema.additionalProperties === false) errors.push(`${path}.${key}: is not an allowed property.`);
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) return [...errors, `${path}: must be an array.`];
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items.`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: allows at most ${schema.maxItems} items.`);
      if (schema.items) value.forEach((item, index) => errors.push(...validateAgentSchema(schema.items!, item, `${path}[${index}]`)));
      break;
    }
    case "string": {
      if (typeof value !== "string") return [...errors, `${path}: must be a string.`];
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: is shorter than ${schema.minLength}.`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: is longer than ${schema.maxLength}.`);
      break;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value)))
        return [...errors, `${path}: must be a finite ${schema.type}.`];
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}.`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}.`);
      break;
    }
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: must be a boolean.`);
      break;
  }
  return errors;
}
