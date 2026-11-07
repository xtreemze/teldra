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


## Interactive lighting profile

`sh3d-preview-v1` in the first visual node's `extras.teldraSourceLighting`
preserves the XML environment's 24-bit `lightColor` and `skyColor`. Studio
replaces its generic hemisphere with four directional lights and 0.2 ambient
fill, and retains native Phong Ka/Kd/Ks/Ns and transparency. Directions use the
same right-handed Y-up frame as the exported OBJ; source brightness multiplies
the directional colors. This is derived presentation, never twin/device state.

Reference: the official [SH3D interactive view API source](https://www.sweethome3d.com/jsdoc/symbols/src/_Users_manu_Desktop_tmp_Developer_Java_SweetHome3DJS_src_HomeComponent3D.js.html),
`createLights` and `updateLightColor`. Numerical scene parameters are interoperable
data; vendor implementation is not bundled.

This profile targets the interactive preview, not the offline photo renderer:
no claim of matching sun/sky ray tracing, fixture power, indirect illumination,
soft shadows, or photo exposure. Those settings and light-source records remain
recoverable in the original source. Sky textures are not yet projected. Existing
packages without this metadata retain their existing preview lighting and must
be regenerated with the converter to acquire this profile.

### Studio shadow-detail presentation

The interactive Studio viewport defaults to 65/100 shadow-detail grading when
`sh3d-preview-v1` is present, applied through Babylon image-processing color
curves after the source lights and materials. It selectively raises shadow and
low-midtone visibility without raising highlights, so dark floor texture is
more legible during editing. The Appearance controls expose 0–100 on desktop
and mobile. Zero disables the grading, and **Restore source appearance** also
restores the ungraded source view. This is a reversible, viewport-only
display policy: it does not alter the source Phong parameters, textures, IFC,
scene-manifest, lighting profile, or serialized project. It cannot invent
texture detail that the source image does not contain. Verify the visual effect
on actual 21D material assets on both WebGL and WebGPU before declaring
photometric parity.

**Floor texture inspection:** Studio's Appearance menu offers an explicitly
unlit, reversible floor-texture view. For imported SH3D room surfaces with a
bound diffuse texture, it temporarily disables lighting on the derived Babylon
StandardMaterial. All material color factors, UVs, source texture bytes, source
lighting metadata and IFC/project state remain untouched; toggling off or
restoring source appearance reinstates the original lighting flags. This mode
is a diagnostic/authoring aid, not a correction to physical indoor illumination
or a claim that the normal renderer has been fixed.

The published 21D reference has 13 textured floor parts and 3 distinct
embedded floor images. Read-only audit `tools/diagnostics/audit_21d_floor.py`
checks actual source Kd/Ka, image brightness, UV variation, and normals.
Run after resolving Git LFS with the Python workspace dependencies. Real-demo
browser tests also assert that all 13 floor textures remain bound and GPU-ready
after Babylon's Phong projection.

To compare GPU pipelines on the same device, Studio recognizes the view-only
`?renderer=webgl` query flag. It skips WebGPU device selection, preserving the
project and imported materials, and reports the selected backend in viewport
status. Without the flag, normal WebGPU-first selection remains unchanged.
This is a diagnostic/fallback path rather than proof that WebGL is correct.


## Viewport navigation and layers

Studio exposes an interactive XYZ orientation gizmo with six axis views,
isometric/top/front/right presets, scene/selection framing, zoom and pan buttons,
and perspective/orthographic projection. The gizmo follows the actual camera.
Pointer orbit/right-button pan/wheel zoom and native two-finger gestures share
one Babylon camera. Canvas-focused keyboard controls are documented in the UI.
Navigation drags and canceled gestures do not issue selection clicks.

SH3D visual nodes carry optional `extras.teldraSourceLayer` with the stable
source `levelId` and `levelName`. The converter derives it from XML source
membership, not world-height guesses (the real file contains two levels at the
same elevation). Regenerate older packages to acquire level metadata. Category
toggles also work on existing packages using canonical source kinds.

Visibility is the intersection of content category, level, and original hidden
source visibility. Revealing hidden content never overrides a disabled category
or level. Fitting ignores hidden meshes, and an empty scene safely leaves the
camera unchanged. Framing selection uses the workspace's canonical selection.
Camera/layer controls never rewrite IFC placement, twin records, source
metadata, undo history, project dirty state or physical automation state.
