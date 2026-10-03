import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}([a-f0-9]{24})?$/;
const ARTIFACT_KINDS = new Set([
  "ifc",
  "glb",
  "scene-manifest",
  "appearance-manifest",
  "lighting-manifest",
  "lightmap",
  "reflection-probe",
  "render",
  "other",
]);

export function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function validateArtifactProvenance(value) {
  const issues = [];

  if (!isRecord(value)) {
    return { valid: false, issues: ["provenance must be an object"] };
  }

  if (value.schemaVersion !== "0.1.0") {
    issues.push("schemaVersion must be 0.1.0");
  }

  if (!isRecord(value.artifact)) {
    issues.push("artifact must be an object");
  } else {
    if (!ARTIFACT_KINDS.has(value.artifact.kind)) {
      issues.push("artifact.kind is unsupported");
    }
    if (!nonEmptyString(value.artifact.path)) {
      issues.push("artifact.path must be non-empty");
    }
    if (!SHA256.test(String(value.artifact.sha256 ?? ""))) {
      issues.push("artifact.sha256 must be lowercase sha256");
    }
  }

  if (!COMMIT.test(String(value.sourceCommit ?? ""))) {
    issues.push("sourceCommit must be a 40- or 64-character lowercase git hash");
  }

  if (!SHA256.test(String(value.toolchainManifestSha256 ?? ""))) {
    issues.push("toolchainManifestSha256 must be lowercase sha256");
  }

  if (!isRecord(value.producer)) {
    issues.push("producer must be an object");
  } else {
    if (!nonEmptyString(value.producer.name)) {
      issues.push("producer.name must be non-empty");
    }
    if (!nonEmptyString(value.producer.version)) {
      issues.push("producer.version must be non-empty");
    }
  }

  if (!isRecord(value.components) || Object.keys(value.components).length === 0) {
    issues.push("components must contain at least one exact component version");
  } else {
    for (const [name, version] of Object.entries(value.components)) {
      if (!nonEmptyString(name) || !nonEmptyString(version)) {
        issues.push("components must map non-empty names to non-empty versions");
        break;
      }
    }
  }

  if (!SHA256.test(String(value.settingsSha256 ?? ""))) {
    issues.push("settingsSha256 must be lowercase sha256");
  }

  if (!Array.isArray(value.inputs) || value.inputs.length === 0) {
    issues.push("inputs must contain at least one source artifact");
  } else {
    for (const input of value.inputs) {
      if (
        !isRecord(input) ||
        !nonEmptyString(input.path) ||
        !SHA256.test(String(input.sha256 ?? ""))
      ) {
        issues.push("each input must contain path and lowercase sha256");
        break;
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function artifactCacheIdentity(provenance) {
  const validation = validateArtifactProvenance(provenance);
  if (!validation.valid) {
    throw new Error(
      `Invalid artifact provenance: ${validation.issues.join("; ")}`,
    );
  }

  const material = {
    toolchainManifestSha256: provenance.toolchainManifestSha256,
    producer: {
      name: provenance.producer.name,
      version: provenance.producer.version,
    },
    components: Object.fromEntries(
      Object.entries(provenance.components).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    settingsSha256: provenance.settingsSha256,
    inputs: [...provenance.inputs]
      .map((input) => ({ path: input.path, sha256: input.sha256 }))
      .sort((left, right) =>
        left.path === right.path
          ? left.sha256.localeCompare(right.sha256)
          : left.path.localeCompare(right.path),
      ),
  };

  return sha256Text(JSON.stringify(material));
}

export function artifactsAreCacheCompatible(left, right) {
  return artifactCacheIdentity(left) === artifactCacheIdentity(right);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
