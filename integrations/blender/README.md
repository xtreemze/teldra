# Blender / Bonsai integration

This boundary will provide the Sweet Home-style authoring experience without making Blender files canonical.

Planned responsibilities:

- simplified home authoring UI;
- IFC authoring through IfcOpenShell/Bonsai-compatible services;
- Blender material and visualization state;
- Cycles reference renders;
- radiance-basis lightmap and reflection-probe baking;
- deterministic web asset export.

Blender-only state must not leak into canonical IFC or twin records unless represented by an explicit portable Teldra contract.
