# Babylon.js runtime

This package owns Teldra's interactive physical scene.

## Boundary

- Babylon.js stays inside this runtime package.
- Canonical IFC/twin state never stores Babylon objects.
- glTF node indices and human-readable names are not identity.
- GLB `extras.teldra.nodeKey` resolves through the versioned scene manifest.
- Pick results exposed to the application are renderer-neutral `TwinRenderIdentity` records.

## Engine

The runtime prefers Babylon WebGPU when supported and falls back to WebGL. The scene uses Babylon's right-handed mode so loaded glTF remains in its native handedness.

## Loading

The runtime uses Babylon's module-level asset-container loader and dynamically registered built-in loaders. A loaded asset is expected to have been produced by Teldra's IFC→GLB exporter so its glTF nodes carry `extras.teldra` metadata matching `scene.manifest.json`.

Babylon's renderer state, camera, GPU resources, and loaded asset containers remain derived presentation state.


## Picking

The public picking boundary is renderer-neutral.

`pick(clientX, clientY)` accepts browser client coordinates, converts them to canvas-local coordinates using the canvas client rect, performs Babylon mesh picking, and resolves the picked render node through the scene manifest to a `TwinRenderIdentity`.

`onPick(listener)` listens to native canvas click events and delegates to the same `pick` primitive. This keeps pointer-event plumbing and programmatic picking consistent while preventing Babylon mesh objects from escaping the runtime.
