# ADR 0016: Reproducible toolchain and derived-artifact provenance

Status: accepted

## Context

Teldra generates IFC, GLB, scene manifests, material assets, lightmaps, reflection probes, and reference renders across JavaScript, Python, IfcOpenShell, and eventually Blender/Bonsai. Derived outputs must not be reused merely because their filenames match.

Reproducibility requires two different records:

1. the toolchain Teldra supports/certifies;
2. the exact producer/tool versions, settings, and inputs used for one generated artifact.

## Supported toolchain manifest

`toolchain/manifest.json` is the machine-readable compatibility authority.

Current baseline:

| Component | Policy |
|---|---|
| Node | `>=24 <25`; CI major 24 |
| pnpm | exactly 12.8.1 |
| Python | `>=3.12 <3.13`; CI 3.12 |
| uv | exactly 0.12.19 |
| IfcOpenShell | exactly 0.9.0 |
| Blender | 5.2.2 LTS; reference-CI certified |
| Bonsai | not yet certified |
| Browsers | release matrix in `quality/budgets.json` |

Blender 5.2.2 LTS is certified by the executable reference pipeline in `integrations/blender/reference/`: CI verifies the official release checksum, performs a Cycles bake, exports GLB, validates UV/PBR/identity semantics, and then the browser suite loads that exact GLB in Babylon. Bonsai remains deliberately uncertified until a Bonsai-specific integration is exercised by CI. Artifact reuse through either authoring path still requires an exact producer version.

Changing an incompatible producer/runtime baseline requires updating the compatibility epoch and invalidates derived artifacts whose recorded toolchain identity no longer matches.

## Manifest hash

Producers hash the exact UTF-8 bytes of `toolchain/manifest.json` with SHA-256 and record that digest as `toolchainManifestSha256`.

This is intentionally conservative: even a policy change that does not alter a particular producer may invalidate a cache. Correctness is preferred to speculative cross-version reuse; narrower compatibility rules can be introduced later with explicit tests.

## Artifact provenance sidecars

Generated artifacts may carry a sidecar manifest conforming to:

`schemas/json/artifact-provenance.schema.json`

Recommended naming:

```text
cache/scene.glb
cache/scene.glb.provenance.json

cache/lighting/living-room.ktx2
cache/lighting/living-room.ktx2.provenance.json
```

Each provenance record contains:

- output artifact kind/path/hash;
- source Git commit;
- toolchain-manifest SHA-256;
- producer name/version;
- exact relevant component versions;
- settings SHA-256;
- input artifact paths and SHA-256 hashes.

The output hash verifies the artifact. It is not part of the cache-input identity.

## Cache compatibility identity

Two generated outputs are reusable across a cache lookup only when the following match:

- toolchain-manifest SHA-256;
- producer name and version;
- exact component-version map;
- settings SHA-256;
- sorted input path/hash set.

Output path/hash and Git commit do not participate in cache-input identity. The same deterministic inputs may therefore reproduce an equivalent artifact at another path or commit.

`tools/toolchain/provenance.mjs` implements and tests this identity.

## Browser policy

Browser support remains owned by `quality/budgets.json` rather than duplicated into a second drifting matrix. The toolchain manifest records that file as the certification source and CI verifies it remains populated.

## CI and release

`pnpm toolchain:check` verifies that:

- root Node/pnpm declarations match the manifest;
- Python and uv pins match;
- every current IFC-producing Python package pins the declared IfcOpenShell version;
- Blender/Bonsai certification state is internally consistent, and the Blender reference workflow matches the certified Blender version;
- browser certification policy exists;
- the provenance schema parses;
- the golden provenance fixture records the current manifest hash.

Release policy names the same manifest as a reproducibility prerequisite.

## Consequences

- derived cache validity is independent from canonical project validity;
- changing IfcOpenShell or future Blender/Bonsai versions cannot silently reuse incompatible outputs;
- support bundles can later include one toolchain hash rather than reproducing an environment by guesswork;
- #32 may discard derived caches safely because they can be regenerated from provenance-bearing inputs.
