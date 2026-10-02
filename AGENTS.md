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

Lower layers must not import higher layers. In particular, domain/application/projection code must not import Babylon.js, deck.gl, SolidJS, Lit, Blender `bpy`, Bonsai, or Home Assistant libraries.

## UI and renderer boundaries

- Teldra Studio uses SolidJS for application UI.
- Portable browser surfaces use Lit custom elements only when framework independence is materially useful.
- Babylon.js and deck.gl runtimes are plain TypeScript adapters and must not depend on SolidJS or Lit.
- Prefer shared headless behavior and design tokens over duplicate SolidJS/Lit implementations.
- React is not part of the planned stack unless a future isolated dependency justifies it.

## Identity

- Teldra IDs share one canonical identity space across building references, devices, capabilities, and bindings.
- Keep Teldra canonical IDs stable.
- Preserve IFC GlobalIds when importing or updating the same architectural element.
- External platform entity IDs belong to binding records and must not replace canonical identity.
- Derived render instances must always resolve back to canonical identity.

## Spatial invariants

- Canonical/project spatial semantics use explicit units, coordinate frames, and transforms.
- Projection/runtime coordinate conversions must be explicit and testable.
- Renderer origin shifting, camera transforms, filtering, and interaction must never rewrite canonical placement.
- Do not rely on implicit axis or unit conventions at IFC, Blender, glTF, Babylon.js, or deck.gl boundaries.

## Mutation

- Mutate canonical building data through IFC-aware application services.
- Mutate twin data through application commands.
- Never let dragging, filtering, camera movement, visualization, or renderer state rewrite architectural evidence or canonical coordinates.

## Development method

Test-driven development is the default for deterministic behavior:

1. express the invariant, use case, or regression as a failing test or fixture;
2. implement the smallest correct behavior;
3. refactor while preserving the tests;
4. add a Storybook story when the behavior has a meaningful visible state;
5. add end-to-end coverage when behavior crosses subsystem boundaries.

Bugs require a reproducing regression test before the fix whenever the failure can be represented deterministically.

## Testing

- Domain contracts require focused unit/invariant tests and schema review.
- Application commands require use-case tests around canonical mutations.
- Projections require contract tests proving stable identity and renderer independence.
- Adapters require tests at their external boundary.
- IFC and SH3D work requires deterministic fixture-based tests.
- Visible SolidJS and Lit states should be represented in Storybook where useful.
- Storybook interaction/accessibility checks complement, but do not replace, Playwright.
- Babylon.js/deck.gl behavior requires real-browser tests for picking, transforms, and synchronization.
- Blender/Cycles work requires headless integration tests and small deterministic reference scenes.
- Generated assets are validated outputs, not source truth.

## Fixtures

Fixtures must be small, deterministic, license-compatible, and tied to a documented invariant or compatibility case. Large binary/reference assets should not silently enter normal Git history.
