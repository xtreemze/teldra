import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  artifactCacheIdentity,
  artifactsAreCacheCompatible,
  sha256Text,
  validateArtifactProvenance,
} from "./provenance.mjs";

const fixtureUrl = new URL(
  "../../fixtures/provenance/web-export.json",
  import.meta.url,
);
const manifestUrl = new URL("../../toolchain/manifest.json", import.meta.url);

const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
const manifestText = await readFile(manifestUrl, "utf8");

test("fixture records the exact toolchain manifest hash", () => {
  assert.equal(
    fixture.toolchainManifestSha256,
    sha256Text(manifestText),
  );
});

test("validates complete artifact provenance", () => {
  assert.deepEqual(validateArtifactProvenance(fixture), {
    valid: true,
    issues: [],
  });
});

test("cache identity changes with toolchain, producer, settings, or input changes", () => {
  const baseline = artifactCacheIdentity(fixture);

  for (const candidate of [
    {
      ...fixture,
      toolchainManifestSha256: "d".repeat(64),
    },
    {
      ...fixture,
      producer: { ...fixture.producer, version: "0.0.1" },
    },
    {
      ...fixture,
      settingsSha256: "e".repeat(64),
    },
    {
      ...fixture,
      inputs: [{ ...fixture.inputs[0], sha256: "f".repeat(64) }],
    },
  ]) {
    assert.notEqual(artifactCacheIdentity(candidate), baseline);
    assert.equal(artifactsAreCacheCompatible(fixture, candidate), false);
  }
});

test("cache identity ignores output path/hash and source commit", () => {
  const rebuilt = {
    ...fixture,
    artifact: {
      ...fixture.artifact,
      path: "cache/new-name.glb",
      sha256: "1".repeat(64),
    },
    sourceCommit: "1".repeat(40),
  };

  assert.equal(
    artifactCacheIdentity(rebuilt),
    artifactCacheIdentity(fixture),
  );
  assert.equal(artifactsAreCacheCompatible(fixture, rebuilt), true);
});

test("component ordering does not change cache identity", () => {
  const reordered = {
    ...fixture,
    components: {
      ifcopenshell: fixture.components.ifcopenshell,
      uv: fixture.components.uv,
      python: fixture.components.python,
    },
  };

  assert.equal(
    artifactCacheIdentity(reordered),
    artifactCacheIdentity(fixture),
  );
});

test("rejects non-JSON-safe provenance metadata shapes", () => {
  const invalid = {
    ...fixture,
    settingsSha256: "not-a-hash",
  };

  const result = validateArtifactProvenance(invalid);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.includes("settingsSha256")),
  );
});
