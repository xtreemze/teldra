# Browser spatial editing and Pages delivery

Status: implemented for upright IFC4 furniture placement and authored device placement.

The browser edits canonical IFC through `@teldra/application` commands and the pinned
`@teldra/ifc-edit` web-ifc 0.0.78 adapter. Babylon gizmos expose drafts only. Apply
commits world-metre XYZ and Z yaw; Cancel restores the committed pose. Scaling,
wall/topology changes, non-metre IFC, tilted or dependent placement hierarchies are
rejected or not offered. Source furniture material/geometry remains unchanged.

Studio now exposes an **Edit transform** action in the viewport project toolbar for a selected
IFC furniture item. It validates the supported IFC4 placement contract before attaching
Move/Rotate gizmos. The inspector remains the accessible precision-input, snap, Apply and Cancel
surface. **Scale is not enabled** until an IFC-backed geometry/dimension command and
validated derived-scene reconciliation exist (tracked in #82). A Babylon-only scale
preview must not be presented as a saved architectural edit.

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
