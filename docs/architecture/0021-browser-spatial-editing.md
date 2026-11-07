# Browser spatial editing and Pages delivery

Status: implemented for upright IFC4 furniture placement and authored device placement; IFC4 mapped-instance scale is experimental and type-gated.

The browser edits canonical IFC through `@teldra/application` commands and the pinned
`@teldra/ifc-edit` web-ifc 0.0.78 adapter. Babylon gizmos expose drafts only. Apply
commits world-metre XYZ and Z yaw; Cancel restores the committed pose. Arbitrary
object-mode scaling, wall/topology changes, non-metre IFC, tilted or dependent
placement hierarchies are rejected. Source materials, representation maps and
GlobalIds remain unchanged. A restricted mapped-instance geometry scaling path
is described below.

Studio now exposes an **Edit transform** action in the viewport project toolbar for a selected
IFC furniture item. It validates the supported IFC4 placement contract before attaching
Move/Rotate gizmos. The inspector remains the accessible precision-input, snap, Apply and Cancel
surface. **Scale is enabled only** when the selected furniture has a uniquely owned
IFC4 Body/MappedRepresentation with one IfcMappedItem and an identity-aligned
mapping target. Representation-free imported SH3D furniture and unsupported
parametric IFC types still cannot be scaled. Babylon-only scaling is forbidden.

## IFC4 mapped-instance scale contract (restricted)

For a supported IfcFurniture, scaling writes a fresh
IfcCartesianTransformationOperator3DnonUniform as the uniquely owned
IfcMappedItem.MappingTarget. It never changes the shared
IfcRepresentationMap, source shape geometry, IfcFurniture GlobalId,
IfC placement hierarchy or unrelated instances. The source and current
mapping factors are captured in local IFC XYZ coordinates. All values
must be finite, strictly positive and at most 1000. Nonidentity axes,
offset mapping origins, shared editable shape chains, missing ShapeRepresentations
and other representation kinds fail closed.

In Studio, the Scale gizmo and S shortcut control a *disposable preview*.
Uniform scaling and per-axis X/Y/Z factors are represented in a local-scale
draft, alongside the pose draft. Enter/Apply sends one application
command for pose and scale, with one IFC undo/redo snapshot. Cancel leaves
canonical bytes unchanged; numerical controls remain available for accessibility.
For simple supported geometry, a per-item affine projection updates the
unchanged GLB preview. Nonuniform transformations requiring shear that Babylon
cannot represent are rejected before IFC commit. A future conversion pipeline
must regenerate GLB derivatives for these cases.

Scene placement reconciliation records with geometry-scale ratios use version
2 of the derived, hash-bound scene placement record; version 1 is still
recognized for rigid-only projects. Scale ratios and matrices are validated
on archive parsing and then cross-checked against authoritative source/current
IFC geometry during browser opening. The canonical IFC remains authoritative.
These overrides are projection artifacts, not an alternate representation owner.

This is **not** support for arbitrary IFC solid scaling, wall editing, source
SH3D visual assets without IFC geometry, multi-item mapped representations,
rotated mapping origins, tilted placements or dependent hierarchies. Issue #82
continues to track broader IFC representation authoring, derived-asset
regeneration, full 21D fixture certification and hardware tests.

Canonical device placement is optional IFC-world metre/Z-up position and a normalized
quaternion. Device placement is authored data, not a physical smart-home command.
No Home Assistant command is dispatched by selecting or dragging an object.

Twin and IFC commands share a chronological undo/redo timeline. Saving stages the twin,
IFC, manifest hashes and explicit GLB placement reconciliation as one project archive,
then performs one file replacement/download. The original IFC used to produce the GLB
is retained as a hash-checked derived source. Reopened placement deltas are checked
against both original and current IFC poses before projection. This is a supported
placement reconciliation, not a general IFC geometry-regeneration engine.

Opaque compatible mesh parts may be merged for rendering. Logical source part counts,
category/level visibility, source materials and per-triangle node identity remain
separate from physical draw meshes. Animated, mirrored, transparent, line, instanced,
skinned and otherwise incompatible meshes are excluded. All furniture parts use the
same canonical transform, including merged parts. Renderer library batching remains
opt-in; Studio enables the tested conservative path.

Pages publishes one combined tree: existing project site/onboarding plus `/studio/`.
The public default demo is the owner-authorized complete 21D home (53.4 MiB), prepared from a hash-verified LFS archive. The 31 KB synthetic room remains at `?demo=sample` for focused editing tests. The original SH3D is embedded byte-identically; all conversion assets are retained. The real demo is added
to the Pages artifact. Local files use direct browser handles when available, or
upload-to-memory and explicit download copies elsewhere. Browser recovery is local.
`pnpm pages:build` validates routes/assets and initial Brotli shell/CSS budgets.
`pnpm --filter @teldra/studio pages:test` runs production-path editing and accessibility
checks, separately from Storybook and real-home rendering checks.

## Evidence and remaining certification

The complete 21D conversion contains 9,512 source parts, 467 materials and 208 images.
At an identical 800x600 view, conservative batching reduced visible draw calls from
4,490 to 879 and median CPU scene-render cost from 22 ms to 8.3 ms. CPU p95 was 47.3 ms
versus 23.9 ms over 30 samples. Only 0.0734% of comparison pixels differed by more than
8 channel values; RMS channel differences were below 1.3. All materials/textures and
logical visibility counts were retained. These are software SwiftShader measurements;
approximately 2 FPS does not certify hardware desktop/mobile frame-rate budgets.

The initial application shell measured 58.1 Brotli KiB (300 KiB budget), with 2.8 KiB
initial CSS (100 KiB budget); renderer and IFC/WASM code load on demand.
Pointer translation/rotation/cancel, canonical IFC apply/undo/redo/save/reopen and
compact-screen Axe accessibility are covered by browser tests.

Open release gates: real GPU performance, real Safari/mobile/touch certification,
broader IFC geometry editing, and independent usability evaluation. The 9/10 UX target
is a target, not a fabricated commercial-certification score. Track current work and
remaining acceptance in issue #80, with release gates #37 and #71-#75.


The canvas fills the workspace. Scene search, inspector, project actions, orientation, camera, layers and appearance controls float within its bounds. Compact screens scroll toolbars horizontally and use mutually exclusive scene/inspector panels. Texture visibility and light gain are disposable view settings; light gain preserves each source-preview light ratio. Source-preview lighting is interactive raster lighting, not source photorenderer parity or path tracing.


## Blender / Bonsai-style navigation and transform shortcuts

The canvas is keyboard-focusable. Studio borrows Blender/Bonsai input
patterns while keeping IFC authoring authority in application commands.

- **G** moves selected supported IFC furniture; **R** rotates it. After G,
  **X**, **Y** or **Z** constrain numeric translation to an IFC-world axis.
  Rotation of upright IFC furniture is Z-only, entered in degrees.
- Enter a signed finite decimal delta (for example G → X → 0.5 → Enter)
  or a rotation angle (R → Z → 45 → Enter). **Backspace** corrects numbers.
  **Enter** commits using the IFC application command; **Escape** discards
  the draft. Pointer gizmos and inspector fields synchronize during editing.
- **S** starts scaling **only** for IFC furniture with a validated per-instance
  mapped geometry target; incompatible representations remain disabled with an
  explanation. Bonsai warns against arbitrary IFC object-mode scaling.
- **MMB** drag orbits, **Shift+MMB** pans, wheel zooms. Left-drag orbit and
  right-drag pan remain supported. Numpad 1/3/7 show front/right/top views,
  5 toggles projection, 2/4/6/8 orbit, Shift+numpad pans, and numpad
  decimal frames selection. **Home** frames scene, Shift+Home resets view;
  F/Shift+F fit scene/selection. **Ctrl/Command+S** saves; Ctrl/Command+Z
  and Ctrl/Command+Shift+Z operate canonical undo/redo.
- Shortcuts require canvas focus and never intercept form input. IFC4 metre,
  upright and independent-placement restrictions still apply. Gizmos cannot
  dispatch Home Assistant physical controls.

References: Blender transform modal map and numeric input documentation,
plus [Bonsai IFC hotkeys](https://docs.bonsaibim.org/reference/general/hotkeys.html).
This is browser-adapted tooling, not a complete imitation of Blender's
free-pointer modal modeling.
