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
