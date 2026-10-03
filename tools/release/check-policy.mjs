import { access, readFile } from "node:fs/promises";
import process from "node:process";

const policyUrl = new URL("../../release/policy.json", import.meta.url);
const policy = JSON.parse(await readFile(policyUrl, "utf8"));
const releaseMode = process.argv.includes("--release");

const fail = (message) => {
  throw new Error(`Invalid release policy: ${message}`);
};

if (policy.schemaVersion !== "0.1.0") {
  fail("unsupported schemaVersion");
}

if (policy.versioning?.product !== "semver") {
  fail("product versioning must use semver");
}

const lockfiles = policy.reproducibility?.requiredLockfiles;
if (!Array.isArray(lockfiles) || lockfiles.length < 2) {
  fail("requiredLockfiles must declare JavaScript and Python locks");
}

for (const required of ["pnpm-lock.yaml", "python/uv.lock"]) {
  if (!lockfiles.includes(required)) {
    fail(`missing required lockfile declaration: ${required}`);
  }
}

if (
  policy.reproducibility?.toolchainManifest !== "toolchain/manifest.json" ||
  policy.reproducibility?.releaseRequiresPinnedToolchainManifest !== true
) {
  fail("reproducibility must require toolchain/manifest.json");
}

const archive = policy.imports?.archive;
for (const [name, value] of Object.entries({
  maxEntries: archive?.maxEntries,
  maxTotalUncompressedMiB: archive?.maxTotalUncompressedMiB,
  maxSingleEntryMiB: archive?.maxSingleEntryMiB,
  maxCompressionRatio: archive?.maxCompressionRatio,
})) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`imports.archive.${name} must be a positive finite number`);
  }
}

for (const requiredFlag of [
  "rejectAbsolutePaths",
  "rejectParentTraversal",
  "rejectSymlinks",
]) {
  if (archive?.[requiredFlag] !== true) {
    fail(`imports.archive.${requiredFlag} must remain enabled`);
  }
}

if (archive?.expandNestedArchives !== false) {
  fail("nested archive expansion must remain disabled by default");
}

if (
  policy.imports?.xml?.allowExternalEntities !== false ||
  policy.imports?.xml?.allowNetworkResolution !== false
) {
  fail("XML external entities and network resolution must remain disabled");
}

if (policy.imports?.gltf?.allowExternalNetworkUrisByDefault !== false) {
  fail("imported glTF must not gain default external network access");
}

const forbiddenSecrets = new Set(policy.secrets?.forbiddenProjectData ?? []);
for (const secret of [
  "home-assistant-access-token",
  "oauth-refresh-token",
  "private-key",
  "password",
]) {
  if (!forbiddenSecrets.has(secret)) {
    fail(`missing forbidden project secret class: ${secret}`);
  }
}

for (const gate of [
  "sha256ChecksumsRequired",
  "ciProvenanceRequired",
  "sbomRequired",
  "dependencyLicenseInventoryRequired",
]) {
  if (policy.releaseArtifacts?.[gate] !== true) {
    fail(`releaseArtifacts.${gate} must remain required`);
  }
}

if (policy.licensing?.blenderExtensionTarget !== "GPL-3.0-or-later") {
  fail("Blender extension target must remain GPL-3.0-or-later");
}
if (policy.licensing?.ifcLibraryDependency !== "LGPL-3.0-or-later") {
  fail("IfcOpenShell library boundary must remain LGPL-3.0-or-later");
}
if (policy.licensing?.sh3dCompatibility !== "clean-room-format-compatibility-only") {
  fail("SH3D compatibility must remain clean-room");
}
if (policy.licensing?.copiedSweetHome3DImplementationInPortableCore !== false) {
  fail("portable core must not contain copied Sweet Home implementation code");
}

if (releaseMode) {
  const root = new URL("../../", import.meta.url);
  const missing = [];

  for (const path of [
    ...lockfiles,
    policy.reproducibility.toolchainManifest,
  ]) {
    try {
      await access(new URL(path, root));
    } catch {
      missing.push(path);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Release readiness failed: missing reproducibility files: ${missing.join(", ")}`,
    );
  }

  if (
    String(policy.licensing?.portableCoreTarget ?? "").includes(
      "owner-approval-required",
    )
  ) {
    throw new Error(
      "Release readiness failed: portable-core license grant still requires repository-owner approval.",
    );
  }
}

console.log(
  releaseMode
    ? "release policy and release-readiness prerequisites OK"
    : "release/security policy OK (development mode)",
);
