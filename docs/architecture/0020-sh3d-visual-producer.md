# ADR 0020: Complete SH3D visual transport

Status: proposed and implemented for reference-scene verification

The clean-room XML parser continues to own SH3D semantics. It includes grouped
furniture leaves and shelf units using their absolute source placements. IFC
mapping remains a separate conservative semantic conversion.

An optional, separately installed Sweet Home 3D producer supplies complete native
visual geometry through public APIs. It runs outside the portable core and only
receives a bounded XML/content archive with the Java serialization entry removed.
Its source-bound receipt covers all produced assets. The independent Wavefront
converter rejects non-local resources and missing textures.

The transport is GLB with all source triangles, lines, UVs, normals, and embedded
textures. Positions convert centimetres to metres in SH3D's right-handed Y-up
transport frame; the existing canonical-to-glTF transform remains explicit.
Source IDs in producer tags bind render parts to the imported IFC GlobalIds and
canonical IDs. Ground/background geometry remains `kind=presentation`.

The normal glTF metallic-roughness material is a portable fallback. Its optional
`extras.teldraSourceMaterial` record retains original Phong Ka/Kd/Ks/Ns, opacity,
index of refraction, and texture association. Babylon's source appearance adapter
projects this explicit profile to StandardMaterial, retaining HDR specular values
and the already-loaded glTF diffuse texture. Ordinary PBR assets keep their
existing rendering path. This is a compatibility profile, not a change to the
baseline PBR/baked-radiance interchange contract.

Texture color semantics follow ADR 0009: untagged source images retain bytes;
ICC-tagged images convert through LittleCMS/Pillow to sRGB at original resolution
with alpha preserved. The report records both source and embedded hashes. The
original SH3D is embedded unchanged so original images and all unprojected source
metadata remain recoverable. Native and Babylon lighting are not asserted to be
pixel-identical.

Native per-shape face culling also travels in the producer tags. The converter
keeps back-face culling by default and creates a double-sided material variant
only for source shapes that disable culling. Making all source surfaces
double-sided would incorrectly render ceiling backs over the furniture.

Original level visibility travels in `extras.teldraSourceVisibility.hidden`.
Hidden geometry is loaded and can be revealed through Studio's viewport control.
This renderer state must never mutate canonical project state or source records.

The converter explicitly distinguishes the full visual path from an opt-in
`--architecture-only` path. Native visual imports refuse unaccounted furniture;
fully transparent source objects may legitimately have no renderable mesh and
are recorded as such. Two unresolved IFC host-wall relationships in 21D do not
remove their native visual geometry and remain reported semantic limitations.
