import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sha256Text,
  validateArtifactProvenance,
} from "./provenance.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export async function checkToolchainPolicy(repoRoot = REPO_ROOT) {
  const errors = [];
  const readText = (relativePath) =>
    readFile(path.join(repoRoot, relativePath), "utf8");

  const [
    manifestText,
    packageText,
    pythonVersion,
    uvConfig,
    qualityText,
    provenanceFixtureText,
    provenanceSchemaText,
    ifcProject,
    importProject,
    exportProject,
    blenderWorkflow,
  ] = await Promise.all([
    readText("toolchain/manifest.json"),
    readText("package.json"),
    readText("python/.python-version"),
    readText("python/uv.toml"),
    readText("quality/budgets.json"),
    readText("fixtures/provenance/web-export.json"),
    readText("schemas/json/artifact-provenance.schema.json"),
    readText("python/packages/teldra-ifc/pyproject.toml"),
    readText("python/packages/teldra-import-sh3d/pyproject.toml"),
    readText("python/packages/teldra-web-export/pyproject.toml"),
    readText(".github/workflows/blender-reference.yml"),
  ]);

  const manifest = JSON.parse(manifestText);
  const packageJson = JSON.parse(packageText);
  const quality = JSON.parse(qualityText);
  const provenanceFixture = JSON.parse(provenanceFixtureText);
  JSON.parse(provenanceSchemaText);

  if (manifest.schemaVersion !== "0.1.0") {
    errors.push("toolchain schemaVersion must be 0.1.0");
  }

  if (packageJson.engines?.node !== manifest.javascript?.node?.supported) {
    errors.push("package.json node engine must match toolchain manifest");
  }

  if (
    packageJson.packageManager !==
    `pnpm@${manifest.javascript?.pnpm?.exact ?? ""}`
  ) {
    errors.push("packageManager pnpm version must match toolchain manifest");
  }

  if (pythonVersion.trim() !== manifest.python?.python?.ci) {
    errors.push("python/.python-version must match toolchain manifest CI version");
  }

  const uvVersion = manifest.python?.uv?.exact;
  if (
    typeof uvVersion !== "string" ||
    !uvConfig.includes(`required-version = "==${uvVersion}"`)
  ) {
    errors.push("python/uv.toml must exactly pin the toolchain uv version");
  }

  const ifcVersion = manifest.python?.ifcOpenShell?.exact;
  for (const [name, project] of [
    ["teldra-ifc", ifcProject],
    ["teldra-import-sh3d", importProject],
    ["teldra-web-export", exportProject],
  ]) {
    if (
      typeof ifcVersion !== "string" ||
      !project.includes(`ifcopenshell==${ifcVersion}`)
    ) {
      errors.push(`${name} must exactly pin IfcOpenShell ${String(ifcVersion)}`);
    }
  }

  for (const tool of ["blender", "bonsai"]) {
    const policy = manifest.authoring?.[tool];
    if (
      policy?.certification === "not-yet-certified" &&
      (policy.supportedVersions?.length ?? 0) !== 0
    ) {
      errors.push(
        `${tool} cannot list supported versions while marked not-yet-certified`,
      );
    }
    if (policy?.artifactReuseRequiresExactVersion !== true) {
      errors.push(`${tool} artifact reuse must require an exact producer version`);
    }
  }

  const blender = manifest.authoring?.blender;
  if (blender?.certification === "reference-ci") {
    if (
      typeof blender.ci !== "string" ||
      !Array.isArray(blender.supportedVersions) ||
      !blender.supportedVersions.includes(blender.ci)
    ) {
      errors.push(
        "reference-CI Blender version must be included in supportedVersions",
      );
    }
    if (
      typeof blender.download !== "string" ||
      !blender.download.includes(
        `blender-${blender.ci}-linux-x64.tar.xz`,
      )
    ) {
      errors.push("Blender download URL must match the reference-CI version");
    }
    if (blender.checksumVerification !== "official-release-sha256") {
      errors.push(
        "Blender reference CI must verify the official release SHA-256",
      );
    }
    if (
      !blenderWorkflow.includes(
        `blender-${blender.ci}-linux-x64.tar.xz`,
      ) ||
      !blenderWorkflow.includes(`blender-${blender.ci}.sha256`)
    ) {
      errors.push(
        "Blender workflow version must match toolchain/manifest.json",
      );
    }
  }

  if (manifest.browsers?.policySource !== "quality/budgets.json") {
    errors.push("browser policy source must remain quality/budgets.json");
  }
  if (
    manifest.browsers?.releaseCertificationRequired !== true ||
    !Array.isArray(quality.browserPolicy?.release) ||
    quality.browserPolicy.release.length === 0
  ) {
    errors.push("release browser certification policy must remain populated");
  }

  if (
    manifest.artifactProvenance?.schemaPath !==
    "schemas/json/artifact-provenance.schema.json"
  ) {
    errors.push("artifact provenance schema path is incorrect");
  }

  const manifestSha256 = sha256Text(manifestText);
  const provenanceValidation = validateArtifactProvenance(provenanceFixture);
  if (!provenanceValidation.valid) {
    errors.push(
      `provenance fixture is invalid: ${provenanceValidation.issues.join("; ")}`,
    );
  } else if (
    provenanceFixture.toolchainManifestSha256 !== manifestSha256
  ) {
    errors.push(
      "provenance fixture toolchainManifestSha256 does not match toolchain/manifest.json",
    );
  }

  return {
    errors,
    manifestSha256,
  };
}

async function main() {
  const result = await checkToolchainPolicy();

  if (result.errors.length > 0) {
    console.error("Teldra toolchain policy violations:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Teldra toolchain policy is valid (manifest sha256 ${result.manifestSha256}).`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
