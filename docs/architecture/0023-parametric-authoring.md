# ADR 0023: Parametric architectural authoring transaction boundary

Status: proposed (implementation tracked by #119, #120 and #121)

## Decision context

Studio currently supports IFC-authoritative placement and restricted mapped-item scaling for eligible furniture. It does not support topology-changing edits of walls, openings, rooms, slabs or arbitrary IFC solids. This ADR specifies the next authoring boundary without treating Babylon render meshes, a 2D drafting canvas, or imported Sweet Home 3D geometry as canonical architectural state.

The canonical architectural source remains `building.ifc`. The versioned twin remains authoritative for devices and external bindings. SH3D input provenance and derived GLB/PBR assets remain distinct from authored IFC state.

## Decision

Introduce renderer-independent **architectural intents** evaluated through an IFC-aware application transaction. A parametric dependency graph is an ephemeral, validated index over canonical IFC entities and their relationships, **not** a second persisted architectural truth. If authored constraints require persistence, encode them in explicitly versioned, IFC-linked metadata with declared identity, provenance, compatibility and migration rules; do not persist unbacked geometry coordinates.

The mutation pipeline is:

1. Resolve semantic identifiers to existing IFC GlobalIds; check element types, ownership, geometry support, unit system and world/local placement frame.
2. Build a disposable edit draft and dependency impact set. Renderers may preview its result, but preview state never changes canonical bytes.
3. Validate proposed dimensions, intersections, host/void/fill relations, placement hierarchy, relationship cycles, spatial containment and representation eligibility.
4. Apply a single IFC-aware command against an isolated candidate model. For a topology operation, update relationships and all affected representations in that same candidate.
5. Validate the complete resulting IFC structural graph, expected preserved identities and no unrelated modifications. Generate and verify the affected scene projection or explicit rebuild plan.
6. Atomically adopt the candidate IFC, derived scene-reconciliation metadata and project history entry. On any failure keep the original project and derived view authoritative; no partial Apply.
7. Save the manifest, IFC, twin and derived hashes using the existing atomic project archive contract. Reopening must reconstruct exactly the same canonical architectural geometry and stable identities.

## Required semantic operations (proposed)

| Intent | Canonical effect | Initial supported subset |
| --- | --- | --- |
| `CreateWall` | Creates a uniquely identified IFC wall and its representation/containment | Straight, vertical, constant-thickness wall |
| `EditWallPath` | Recomputes an owned wall representation and connected junctions | Planar straight segments in metre-based IFC4 |
| `CreateSpace` | Creates a semantic IFC space and boundary relations | Simple closed, non-self-intersecting plan polygon |
| `InsertOpening` | Creates hosted void relationship and regenerates wall cut | Rectangular hosted opening in a supported straight wall |
| `PlaceHostedElement` | Adds door/window, fill relation and placement | Single host/opening association |
| `AssignSurfaceFinish` | Changes explicit design finish metadata and derived material | A supported wall face or floor surface |

These are proposed contracts, not a claim that implementation already exists. IFC representation specifics and naming must be finalized against IfcOpenShell/web-ifc fixture behavior before any command becomes available in Studio.

## Dependency graph

- Wall endpoints/junctions: modifying a connected endpoint invalidates every incident wall geometry and join.
- Hosted openings: changing host wall geometry invalidates associated opening geometry, dependent door/window placements and host solid subtraction.
- Spaces: modifying bounding wall geometry invalidates affected `IfcSpace` boundaries and derived quantities.
- Floors/ceilings: dependency policies must be explicit for slabs derived from room outlines. Do not assume that imported slab geometry is auto-derived.
- Deletion: reject or transactionally rehome/delete dependent elements; do not silently orphan host relations.
- The graph indexes IFC relationships by stable GlobalId, checks cycles and reports unsupported topology. Dirty sets are computed deterministically, including coincident-but-unconnected geometry distinctions.

## Spatial and numeric contract

- Canonical coordinates: right-handed Z-up, explicit metre units and documented IFC-to-world transforms. Non-metre or unsupported tilted models remain read-only until converted by a validated authoring adapter.
- Editing constraints use physical-unit tolerances, not screen pixels. Conversion between screen-space snapping and model-space values occurs only at the UI/input boundary.
- Reject nonfinite coordinates, zero/negative thickness, invalid polygon rings, degenerate/inverted solids, ambiguous host selection, self-intersection and invalid IFC relationships.
- Geometric epsilon and angle tolerance must be fixture-tested and represented as named policy constants; do not let renderer camera distance determine authored snapping accuracy.
- Preserve unchanged GlobalIds, IFC element types, property sets, material relationships, source SH3D bytes and all device/twin bindings. New architectural elements get new IDs; mere shape changes do not.

## View and interaction contract

- One selection identity connects 2D drafting, 3D Babylon viewport, inspector, keyboard and mobile gestures.
- Canvas gestures and gizmos submit typed intents; they do not call IFC mutation directly.
- Draft state provides Apply, Cancel, accessible numeric equivalents, snap guidance and explicit unsupported reasons.
- Undo/redo operates on one chronological history containing twin and IFC transactions. Cancel and invalid Apply do not enter history.
- Section, plan, elevation and room measurements are derived and never independent geometry records.
- Never dispatch physical Home Assistant commands from geometry authoring.

## Initial certification fixture

A small deterministic two-room IFC4 project must cover:
1. Four straight walls connected at corners, valid space polygon and measured dimensions.
2. A hosted rectangular opening and one door with IFC void/fill relationships.
3. Moving one wall endpoint recomputes affected walls, room area, opening and 2D/3D projections.
4. Unsupported/invalid edits leave byte-identical IFC/manifest/history after Cancel or rejection.
5. Apply -> undo -> redo -> atomic save -> reopen preserves every existing GlobalId, derived selection identity and architectural geometry.
6. Editing a wall does not change unrelated furniture source, GLB scene assets, twin references, Home Assistant bindings or source SH3D archive.
7. Tests cover metre conversion, near-collinear and overlapping walls, self-intersection, missing hosts, orphan dependencies and IFC/GLB rebuild failure.

Implement the smallest passing vertical slice through #119 and #121 before expanding to arbitrary wall curves, multi-level topology or native mesh modeling. Add browser integration and physical touch certification in #120, using existing pointer ownership and scale safety from #82/#90.

## Non-goals

- No Babylon mesh transform as permanent BIM geometry.
- No arbitrary IFC solid/Boolean editing without validated representation support.
- No automatic back-export into `.sh3d`.
- No assumption that all materials or SH3D object groups can be converted losslessly.
- No bundled proprietary furniture/material catalog.
- No unsupported promise of Blender/Bonsai edit roundtrip parity before #125 certification.

## Cross-references

- `AGENTS.md`: authority, identity, spatial and mutation contracts
- `docs/architecture/0007-sh3d-ifc-mapping.md`: SH3D provenance and coordinate mapping
- `docs/architecture/0021-browser-spatial-editing.md`: existing IFC furniture edit restrictions
- #119: topology and canonical transaction foundation
- #120: 2D plan editor
- #121: wall/space/opening/door authoring
- #122: furnishing, #123: finishes, #124: documentation, #125: Bonsai interoperability
- #74: compatibility and fault injection; #82: transform limits; #90: touch certification


## Implemented restricted headless workflow (November 2026)

The full Studio transaction described above remains proposed. A supported
**architecture-only new-copy** path exists for independent straight IFC4 walls.
It refuses archives retaining the original `source.sh3d` or native visual
producer assets, because the original 21D materials and scene geometry cannot
yet be regenerated losslessly.

From the `python/` workspace, first inspect the input archive without mutation:

```sh
uv run --locked python ../tools/import/inspect_wall_project.py source.teldra
```

The JSON report includes `sourceSha256`, IFC storey GlobalIds, and per-wall
`editable`/`deletable` flags with precise blocking reasons. In Studio, select
a wall and open **Scene → Wall draft (2D)**. After reviewing the intended
replacement geometry, use **Export selected wall edit JSON**. The draft
contains the selected wall's compressed IFC GlobalId and exactly the
world-metre centreline and dimensions entered; Studio does **not** infer or
preload the existing wall's geometry. This intentionally prevents misleading
visual claims for a partially mapped wall.

Apply the handoff to a **new destination file** with the reviewed source digest:

```sh
uv run --locked python ../tools/import/edit_wall_project.py \
  source.teldra edited.teldra \
  --edit-draft-file teldra-wall-edit.json \
  --expected-source-sha256 SOURCE_SHA256_FROM_PREFLIGHT
```

The writer revalidates wall representation ownership, hosted openings,
connectivity and source SHA-256, then rebuilds and verifies IFC/twin/GLB/scene
provenance before atomic publication. Existing IFC GlobalIds are preserved
when wall geometry is replaced. To create a wall, use Studio's
`teldra-wall-draft-v1` export with `--storey-guid GUID --draft-file FILE`.
To delete an eligible independent wall, use `--delete-wall-guid GUID` and
`--expected-source-sha256`; deletions are blocked if a Teldra device still
references the wall or if no renderable scene elements would remain.

These operations do not constitute full browser IFC Apply, connected-junction
or hosted-opening editing, source SH3D roundtrip or 21D visual parity. Such
operations must remain unavailable in Studio until the complete transaction
and material-preserving reconciliation tests in this ADR pass.


## Amendment: TypeScript IFC wall write path (November 2026, #119/#121)

A browser-capable wall writer now exists beside the Python archive CLI. It does
not replace it: the CLI remains the only path that rebuilds derived GLB/scene
artifacts and verifies archives. The TypeScript path edits canonical IFC bytes only.

- `@teldra/ifc-edit` (`src/wall.ts`): `readWall`, `planWallUpdate`/`updateWall`,
  `planWallCreate`/`createWall`, `planWallRemove`/`removeWall`, and
  `createIfcWallAdapter`. Coordinates are IFC world metres, Z up; the wall axis is
  the placement local X axis and the Body is the rectangle `(0,0)-(L,t)` extruded by
  height, the same layout the importer and IfcOpenShell `create_2pt_wall` produce.
  Anything else fails closed with a `WallEditError` code.
- `@teldra/application` (`IfcWallEditor`): validate, `preview` (non-mutating), and
  atomic `apply` of one or more operations as one undo unit. The inverse is an
  `ifc.restore` snapshot command, identical in shape to `IfcFurnitureEditor`, so
  undo restores byte-identical IFC and `StudioProjectController` can merge both
  editors into one history. A failing operation publishes nothing.
- Identity: updates rewrite geometry in place and never touch GlobalIds. Created
  walls take a caller-supplied compressed GlobalId (the application layer owns ID
  generation; the writer is deterministic) and duplicates are rejected.
- Connectivity: `IfcRelConnectsPathElements` with `ATSTART`/`ATEND` on both sides
  couples endpoints. Moving an endpoint moves every coupled endpoint (transitively)
  so joints stay coincident; connected walls keep their thickness and height. Each
  affected wall is validated, and a neighbour that would collapse rejects the whole
  edit, naming it. `ATPATH`/`NOTDEFINED` (T-junction) walls reject axis moves.
- Preconditions (explicit error codes): IFC4 metre model; no `IfcRelVoidsElement`
  (`hosted-opening`); only containment, property-set, material and path-connection
  relationships (`unsupported-relationship`); placement and representation entities
  owned solely by the wall (`shared-geometry`). Removal additionally requires that
  nothing but spatial containment references the wall (`wall-referenced`).

Not yet supported, and therefore not offered by Studio: re-hosting openings and
doors, junction mitring/trimming and T-junction recomputation, `IfcRelSpaceBoundary`
and room recomputation, curved/profiled walls, twin-device reference checks
(application commands on `twin.json` must veto removal), derived GLB/scene rebake,
and cross-checking the output with IfcOpenShell (covered today by web-ifc re-open
tests on the hand-authored fixture `fixtures/ifc/connected-walls/`).
