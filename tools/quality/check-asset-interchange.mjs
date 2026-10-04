import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));

const [
  policy,
  scene,
  appearance,
  lighting,
  twin,
] = await Promise.all([
  readJson("quality/asset-interchange.json"),
  readJson("fixtures/projects/golden-home/scene.manifest.json"),
  readJson("fixtures/projects/golden-home/appearance.manifest.json"),
  readJson("fixtures/projects/golden-home/lighting.manifest.json"),
  readJson("fixtures/projects/golden-home/twin.json"),
]);

const fail = (message) => {
  throw new Error(`Invalid asset interchange contract: ${message}`);
};

if (policy.schemaVersion !== "0.1.0") {
  fail("unsupported schemaVersion");
}

if (policy.materialProfile?.model !== "metallic-roughness") {
  fail("material model must remain metallic-roughness");
}
if (policy.materialProfile?.workingRadianceSpace !== "linear-srgb") {
  fail("working radiance space must remain linear-srgb");
}
if (policy.materialProfile?.primaryUvSet !== 0) {
  fail("primary material UV set must remain 0");
}
if (policy.materialProfile?.lightmapUvSet !== 1) {
  fail("lightmap UV set must remain 1");
}
if (
  policy.materialProfile?.metallicRoughnessPacking !==
  "g-roughness-b-metallic"
) {
  fail("metallic/roughness packing must remain G roughness / B metallic");
}

const expectedTransfers = {
  "base-color": "srgb",
  emissive: "srgb",
  normal: "linear",
  occlusion: "linear",
  "metallic-roughness": "linear",
};
for (const [semantic, transfer] of Object.entries(expectedTransfers)) {
  if (policy.materialProfile?.textureTransfer?.[semantic] !== transfer) {
    fail(`texture semantic ${semantic} must use ${transfer} transfer`);
  }
}

if (policy.identity?.sceneNodeAuthority !== "scene-manifest-nodeKey") {
  fail("scene node identity must remain scene-manifest nodeKey");
}
if (policy.identity?.materialAuthority !== "appearance-manifest-materialKey") {
  fail("material identity must remain appearance-manifest materialKey");
}
if (
  policy.identity?.rendererNamesAreAuthority !== false ||
  policy.identity?.blenderObjectNamesAreAuthority !== false
) {
  fail("renderer/Blender names must remain non-authoritative");
}

const geometryStages = policy.compression?.geometry?.optionalStages;
if (
  !Array.isArray(geometryStages) ||
  !geometryStages.includes("meshopt") ||
  !geometryStages.includes("draco")
) {
  fail("geometry compression policy must explicitly cover meshopt and draco");
}
if (policy.compression?.geometry?.semanticIdentityMustSurvive !== true) {
  fail("geometry optimization must preserve semantic identity");
}
if (policy.compression?.geometry?.canonicalTransformMustSurvive !== true) {
  fail("geometry optimization must preserve canonical transforms");
}
if (policy.compression?.textures?.runtimeContainer !== "ktx2") {
  fail("runtime texture container must remain KTX2");
}

if (policy.invalidation?.requiresArtifactProvenance !== true) {
  fail("derived assets must require artifact provenance");
}
for (const required of [
  "source-geometry-hash",
  "scene-manifest-hash",
  "appearance-manifest-hash",
  "uv-layout",
  "material-semantics",
  "lighting-groups",
  "bake-settings",
  "producer-version",
  "toolchain-manifest-hash",
  "compression-settings",
]) {
  if (!policy.invalidation?.invalidateOn?.includes(required)) {
    fail(`missing invalidation input: ${required}`);
  }
}

if (scene.appearanceManifestPath !== "appearance.manifest.json") {
  fail("golden scene must bind appearance manifest");
}
if (scene.lightingManifestPath !== "lighting.manifest.json") {
  fail("golden scene must bind lighting manifest");
}

const sceneNodeKeys = new Set(scene.nodes.map((node) => node.nodeKey));
const materialKeys = new Set();
for (const material of appearance.materials) {
  if (materialKeys.has(material.materialKey)) {
    fail(`duplicate appearance materialKey: ${material.materialKey}`);
  }
  materialKeys.add(material.materialKey);

  for (const nodeKey of material.nodeKeys) {
    if (!sceneNodeKeys.has(nodeKey)) {
      fail(`appearance material ${material.materialKey} targets unknown nodeKey ${nodeKey}`);
    }
  }

  for (const texture of material.textures) {
    if (texture.uvSet !== policy.materialProfile.primaryUvSet) {
      fail(
        `appearance material ${material.materialKey} texture ${texture.semantic} must use UV0`,
      );
    }

    const expected = policy.materialProfile.textureTransfer[texture.semantic];
    if (expected === undefined) {
      fail(`appearance uses unclassified texture semantic ${texture.semantic}`);
    }
  }
}

if (lighting.radianceSpace !== policy.materialProfile.workingRadianceSpace) {
  fail("lighting manifest radiance space must match asset policy");
}
if (lighting.composition !== "additive-linear") {
  fail("lighting composition must remain additive-linear");
}

const deviceIds = new Set(twin.devices.map((device) => device.id));
const assignedLights = new Set();
for (const basis of lighting.radianceBases) {
  if (basis.uvSet !== policy.materialProfile.lightmapUvSet) {
    fail(`radiance basis ${basis.basisId} must use UV1`);
  }
  if (basis.texture?.format !== policy.compression.textures.runtimeContainer) {
    fail(`radiance basis ${basis.basisId} must use KTX2`);
  }

  for (const nodeKey of basis.nodeKeys) {
    if (!sceneNodeKeys.has(nodeKey)) {
      fail(`radiance basis ${basis.basisId} targets unknown nodeKey ${nodeKey}`);
    }
  }

  if (basis.kind === "fixture-group") {
    for (const lightId of basis.lightIds) {
      if (!deviceIds.has(lightId)) {
        fail(`fixture basis ${basis.basisId} targets unknown canonical device ${lightId}`);
      }
      if (assignedLights.has(lightId)) {
        fail(`canonical light ${lightId} belongs to multiple fixture bases`);
      }
      assignedLights.add(lightId);
    }
  } else if (basis.lightIds.length > 0) {
    fail(`${basis.kind} basis ${basis.basisId} must not bind device lights`);
  }
}

for (const probe of lighting.reflectionProbes) {
  for (const state of probe.states) {
    if (state.texture?.format !== policy.compression.textures.runtimeContainer) {
      fail(`reflection probe ${probe.probeId}/${state.stateId} must use KTX2`);
    }
  }
}

if (policy.certification?.contractFixture !== "fixtures/projects/golden-home") {
  fail("Golden Home must remain the contract certification fixture");
}
if (policy.certification?.babylonIdentityPathCertified !== true) {
  fail("Babylon identity path certification must remain explicit");
}
if (policy.certification?.blenderCyclesVisualParity !== "pending") {
  fail(
    "Blender/Cycles parity must remain pending until a real bake/export fixture is certified",
  );
}

console.log(
  `asset interchange OK: ${appearance.materials.length} materials, ${lighting.radianceBases.length} radiance bases, ${lighting.reflectionProbes.length} reflection probes`,
);
