# Blender / Bonsai integration

This boundary provides offline authoring/rendering services without making Blender files canonical.

Implemented responsibilities:

- an executable Blender 5.2.2 LTS reference pipeline under `reference/`;
- deterministic GLB export with Teldra identity in glTF extras;
- UV0/UV1 interchange certification;
- Principled BSDF → glTF metallic-roughness certification;
- Cycles reference-light bake generation;
- CI verification against checked-in reference artifacts;
- Babylon browser parity against the Blender-generated GLB.

Planned responsibilities:

- simplified home authoring UI;
- IFC authoring through IfcOpenShell/Bonsai-compatible services;
- production radiance-basis lightmap and reflection-probe baking;
- deterministic production web-asset export and KTX2 delivery.

Bonsai is not yet certified. Its compatibility with the selected Blender line is not treated as a Teldra guarantee until a Bonsai-specific path is exercised in CI.

Blender-only state must not leak into canonical IFC or twin records unless represented by an explicit portable Teldra contract.
