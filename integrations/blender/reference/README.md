# Blender reference pipeline

This directory contains the executable proof for ADR 0009.

The reference scene is generated from `source.json`; the Blender script creates a tiny mesh with:

- canonical right-handed Z-up metre geometry;
- UV0 for material coordinates;
- UV1 for baked-lighting coordinates;
- a Principled BSDF metallic-roughness material;
- Teldra canonical/IFC identity in glTF extras;
- a small Cycles diffuse-light bake;
- GLB plus a renderer-neutral scene manifest.

The reference bake remains a PNG intermediate. The portable runtime delivery contract remains KTX2 as defined by ADR 0009; this fixture proves the bake boundary without freezing a KTX2 codec profile.

Blender is a derived-authoring/rendering tool here. `source.json` is only a synthetic certification input and is not a substitute for canonical IFC in a real project.
