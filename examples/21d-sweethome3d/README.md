# 21D Sweet Home 3D reference project

Owner-supplied source project and adjacent export assets uploaded from Documents on 26 October 2026.

- `21D.sh3d`: original Sweet Home 3D project with embedded content.
- `21D.obj` and `21D.mtl`: derived Wavefront geometry and materials.
- 229 JPEG/PNG textures, preserving their original names and bytes.
- `manifest.json`: sizes, SHA-256 checksums, provenance, and bounded validation results.

The 232 source files are stored using Git LFS. Run `git lfs pull` after cloning. Keep the OBJ, MTL, and textures together. All 207 distinct MTL texture references resolve. The SH3D ZIP directory is readable and contains Home.xml. Copies were verified byte-for-byte using SHA-256. Application opening, rendering, and Teldra import compatibility have not been verified.

This is a large reference example outside the automated synthetic fixture corpus. The SH3D remains source evidence; the OBJ export is derived. No IFC conversion or canonical Teldra identity is asserted.

## Local compatibility verification (26 October 2026)

After the hexadecimal-color parser correction, the original archive parses as
2 levels, 82 walls, 13 rooms, 150 supported furniture items, and 2 cameras. The
conversion command documented in `python/README.md` maps 247 source identities
into IFC and exports 82 wall identities into the Studio scene. A local Chromium
test opened the resulting `21D.teldra` through Studio's production archive loader
and reached viewport status `ready` using WebGL with no page errors.

This verifies the converted architectural scene, not direct `.sh3d` opening or
full visual fidelity. Grouped furniture and shelf units remain unsupported; two
door/window host matches fail explicitly. Furniture models/textures and original
appearance are not converted. The original files in this directory are unchanged.

Individual models and textures may be third-party assets. Their authors and license terms have not been supplied or verified; no blanket license is asserted for these files.
