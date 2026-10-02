# Teldra

Teldra is a BIM-backed smart-home digital twin designed to combine Sweet Home 3D-style simplicity, Bonsai/IFC semantics, Blender rendering quality, Babylon.js interaction, and deck.gl analytical visualization.

## Architecture

```text
                    project
                       |
          +------------+------------+
          |                         |
     building.ifc                twin.json
  architectural truth        smart-home truth
          |                         |
          +------------+------------+
                       |
                 TwinProjection
                       |
         +-------------+-------------+
         |             |             |
      Babylon        deck.gl       Blender
      physical       analytics      authoring /
       twin          overlays       offline render
```

IFC is authoritative for the building. The versioned Teldra twin model is authoritative for devices, capabilities, external bindings, and runtime semantics. Renderers, authoring tools, exported GLB files, and baked lighting are downstream projections or derived artifacts.

See [AGENTS.md](./AGENTS.md) and [docs/architecture](./docs/architecture/) before changing a domain boundary.

## Repository layout

- `packages/domain`: canonical twin contracts and integrity rules.
- `packages/projection`: renderer-neutral visualization contracts.
- `packages/runtime-babylon`: physical interactive renderer boundary.
- `packages/runtime-deck`: analytical visualization boundary.
- `packages/runtime-compositor`: shared viewport/camera/picking coordination.
- `schemas/json`: language-neutral serialized project/twin contracts.
- `integrations/blender`: Blender/Bonsai authoring and offline rendering.
- `integrations/home-assistant`: automation-platform adapter.
- `python`: IFC/import/build/bake toolchain.

## Development

Requirements:

- Node.js 24+
- pnpm 12.8.1

```bash
pnpm install
pnpm typecheck
pnpm test
```

The bootstrap intentionally does not add Babylon.js, deck.gl, React, IfcOpenShell, or Blender dependencies yet. The first merge establishes the authority and projection boundaries those implementations must obey.
