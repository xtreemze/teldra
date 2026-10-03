# Blender reference pipeline

This directory contains the executable proof for ADR 0009. Its synthetic input lives at `fixtures/blender/reference/source.json`.

The reference scene generator creates a tiny mesh with:

- canonical right-handed Z-up metre geometry;
- UV0 for material coordinates;
- UV1 for baked-lighting coordinates;
- a Principled BSDF metallic-roughness material;
- Teldra canonical/IFC identity in glTF extras;
- a small Cycles diffuse-light bake;
- GLB plus a renderer-neutral scene manifest and certification metadata.

CI runs the exact Blender version declared in `toolchain/manifest.json`, verifies the official Blender release SHA-256, regenerates the artifacts, and byte-compares them with the checked-in fixture.

The reference bake remains a PNG intermediate. Portable runtime delivery remains KTX2 as defined by ADR 0009; this fixture proves the Blender/Cycles bake boundary without freezing a particular KTX2 codec profile.

Blender is a derived authoring/rendering tool here. The synthetic source is certification input only and is not a substitute for canonical IFC in a real Teldra project.
