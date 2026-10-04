import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));

test("asset interchange policy fixes renderer-neutral UV/color/compression semantics", async () => {
  const policy = await readJson("quality/asset-interchange.json");

  assert.equal(policy.materialProfile.primaryUvSet, 0);
  assert.equal(policy.materialProfile.lightmapUvSet, 1);
  assert.equal(policy.materialProfile.workingRadianceSpace, "linear-srgb");
  assert.equal(policy.materialProfile.textureTransfer["base-color"], "srgb");
  assert.equal(policy.materialProfile.textureTransfer.emissive, "srgb");
  assert.equal(policy.materialProfile.textureTransfer.normal, "linear");
  assert.equal(policy.compression.textures.runtimeContainer, "ktx2");
  assert.deepEqual(
    [...policy.compression.geometry.optionalStages].sort(),
    ["draco", "meshopt"],
  );
  assert.equal(policy.identity.rendererNamesAreAuthority, false);
  assert.equal(policy.identity.blenderObjectNamesAreAuthority, false);
});

test("Golden Home appearance and lighting only target scene-manifest identities", async () => {
  const [scene, appearance, lighting] = await Promise.all([
    readJson("fixtures/projects/golden-home/scene.manifest.json"),
    readJson("fixtures/projects/golden-home/appearance.manifest.json"),
    readJson("fixtures/projects/golden-home/lighting.manifest.json"),
  ]);

  const nodeKeys = new Set(scene.nodes.map((node) => node.nodeKey));

  for (const material of appearance.materials) {
    for (const nodeKey of material.nodeKeys) {
      assert.ok(nodeKeys.has(nodeKey), `unknown material nodeKey ${nodeKey}`);
    }
  }

  for (const basis of lighting.radianceBases) {
    for (const nodeKey of basis.nodeKeys) {
      assert.ok(nodeKeys.has(nodeKey), `unknown lighting nodeKey ${nodeKey}`);
    }
  }
});

test("compression never becomes identity authority", async () => {
  const policy = await readJson("quality/asset-interchange.json");

  assert.equal(policy.identity.sceneNodeAuthority, "scene-manifest-nodeKey");
  assert.equal(policy.compression.geometry.semanticIdentityMustSurvive, true);
  assert.equal(policy.compression.geometry.canonicalTransformMustSurvive, true);
  assert.equal(
    policy.optimizationOrder.indexOf("identity-annotation") <
      policy.optimizationOrder.indexOf("geometry-optimization"),
    true,
  );
});

test("Blender/Cycles to Babylon reference parity is pinned to the certified producer", async () => {
  const [policy, producer] = await Promise.all([
    readJson("quality/asset-interchange.json"),
    readJson("integrations/blender/reference-toolchain.json"),
  ]);

  assert.equal(policy.certification.blenderCyclesVisualParity.status, "certified");
  assert.equal(
    policy.certification.blenderCyclesVisualParity.blenderVersion,
    producer.blenderVersion,
  );
  assert.equal(producer.status, "certified");
  assert.equal(producer.blenderVersion, "4.5.14");
  assert.equal(producer.buildHash, "62c1db4208e8");
});
