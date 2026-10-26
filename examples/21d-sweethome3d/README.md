# 21D Sweet Home 3D reference project

Owner-supplied source project and adjacent export assets uploaded from Documents on 26 October 2026.

- `21D.sh3d`: original Sweet Home 3D project with embedded content.
- `21D.obj` and `21D.mtl`: derived Wavefront geometry and materials.
- 229 JPEG/PNG textures, preserving their original names and bytes.
- `manifest.json`: sizes, SHA-256 checksums, provenance, and bounded validation results.

The 232 source files are stored using Git LFS. Run `git lfs pull` after cloning.
Keep the original OBJ, MTL, and textures together. All 207 distinct references in
that older MTL resolve. Original copies were verified byte-for-byte using SHA-256.

This large reference example stays outside the synthetic fixture corpus. The
SH3D remains source evidence; OBJ/GLB exports are derived. The original uploaded
files are unchanged. Fresh conversion uses the SH3D rather than trusting the
older adjacent OBJ to represent the latest source state.

## Local compatibility verification (26 October 2026)

The parser includes grouped furniture leaves and shelf units: 2 levels, 82 walls,
13 rooms, 190 furniture/door/light/shelf records, and 2 cameras. IFC maps 287
source identities. A fresh XML-only native export includes the hidden Ceiling
Treatment level, giving 9,512 mesh parts, 786,070 triangles, 395 line segments,
467 materials, and 208 referenced textures.

All 82 walls and 13 rooms have native visual geometry. Of 190 furniture records,
185 have visual geometry; 5 fully transparent door frames intentionally do not
render and remain preserved as source/IFC records. 9,510 mesh parts bind back to
IFC/canonical source identities; 2 ground/background parts remain presentation
geometry. All 5,022 hidden source parts are retained and can be revealed in Studio.

The full conversion documented in `python/README.md` creates a portable `.teldra`
with every used image embedded at original resolution, source Phong material
parameters, and the untouched original SH3D archive. Ten ICC-tagged images are
color-managed to sRGB; ordinary images retain their exact bytes. Source and
embedded checksums are recorded separately. Studio's production loader reaches
`ready` / WebGL with zero page errors; a local viewport inventory verifies all
mesh parts and loaded texture instances. Khronos validation reports zero errors
and zero warnings for the complete GLB.

This is a complete visual-asset conversion, not direct `.sh3d` picker support or
a claim of identical lighting between Java 3D and Babylon. Two semantic IFC
door/window host matches remain unresolved and reported; their native visual
geometry is present. Source camera and other unprojected settings remain in the
embedded original archive; Studio supplies its own interactive camera/lighting.

Individual models and textures may be third-party assets. Some source records
include creator/license strings, but complete provenance and redistribution terms
have not been verified; no blanket license is asserted for these files.
