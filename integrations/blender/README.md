# Blender / Bonsai integration

This boundary provides offline authoring/rendering services without making Blender files canonical.

Current responsibilities:

- simplified home authoring UI boundary;
- IFC authoring through IfcOpenShell/Bonsai-compatible services;
- Blender material and visualization state;
- Cycles reference renders;
- radiance-basis lightmap and reflection-probe baking;
- deterministic web asset export;
- reproducible Blender/Cycles → GLB → Babylon certification.

## Certified reference producer

Blender 4.5.14 LTS is certified as the current reference producer on Linux x64.

The exact producer policy is recorded in `reference-toolchain.json`. CI downloads the versioned official Blender archive, verifies it against Blender's upstream SHA-256 manifest, runs CPU Cycles headlessly, exports a GLB, verifies UV/material/Teldra identity semantics, then loads the generated artifact through the real Studio/Babylon Chromium path.

The certification is intentionally renderer-neutral at the contract boundary: Blender object names and Babylon mesh IDs are never canonical identity.

Bonsai remains uncertified as a producer until a workflow actually depends on and certifies a specific version.

Blender-only state must not leak into canonical IFC or twin records unless represented by an explicit portable Teldra contract.
