# Teldra contributor contract

Teldra is a BIM-backed smart-home digital twin. Preserve these invariants in every change.

## Authority

1. IFC is authoritative for building geometry, spatial structure, and architectural identity.
2. The versioned Teldra twin format is authoritative for device identity, capabilities, external-system bindings, and runtime semantics.
3. Renderers and authoring tools consume projections. They are not canonical stores.
4. `.blend`, `.glb`, baked textures, reflection probes, GPU resources, camera state, and layout state are derived artifacts.
5. Home Assistant is the first automation adapter, not the domain model.

## Dependency direction

```text
schemas -> domain -> application -> projection -> adapters/renderers -> apps
```

Lower layers must not import higher layers. In particular, domain/application/projection code must not import Babylon.js, deck.gl, React, Blender `bpy`, Bonsai, or Home Assistant libraries.

## Identity

- Teldra IDs share one canonical identity space across building references, devices, capabilities, and bindings.
- Keep Teldra canonical IDs stable.
- Preserve IFC GlobalIds when importing or updating the same architectural element.
- External platform entity IDs belong to binding records and must not replace canonical identity.
- Derived render instances must always resolve back to canonical identity.

## Mutation

- Mutate canonical building data through IFC-aware application services.
- Mutate twin data through application commands.
- Never let dragging, filtering, camera movement, visualization, or renderer state rewrite architectural evidence or canonical coordinates.

## Testing

Changes to domain contracts require focused unit tests and schema review. Changes to projections require contract tests proving stable identity and renderer independence. Adapter changes require tests at the adapter boundary. Generated assets are validated outputs, not source truth.
