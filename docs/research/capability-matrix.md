# Capability matrix: Sweet Home 3D, Blender + Bonsai, Teldra

Research for #125 (Blender/Bonsai interoperability) and #135 (SH3D 21D parity). Written 2026-11-19 against
`main` at 3c7ae06. Nothing here changes canonical contracts; it records what was run, what was observed
and which gaps are tracked.

Evidence legend: **[ran]** executed in this research, **[inv]** read from the 21D `Home.xml` inventory,
**[doc]** product behaviour from vendor documentation or Teldra docs, not executed here. Sweet Home 3D 7.6.1
was only used as the source of `21D.sh3d` content and was not driven interactively, so its column is
[inv]/[doc].

## 1. Toolchain used (exact)

| Tool | Version | Install |
|---|---|---|
| Blender | 5.3.0 (hash 02f0899d78e3, built 2026-11-10), bundled Python 3.13.13 | `brew install --cask blender` |
| Bonsai | 0.9.0-post1 from extensions.blender.org, bundles IfcOpenShell 0.9.0.post1 | `blender --online-mode -b --command extension install -e bonsai` |
| Bonsai (unstable, registered, not installed) | 0.9.1-alpha261119 (macOS arm64 builds for Blender 4.5-5.1 and 5.1+) | `blender -b --command extension repo-add --name "Bonsai unstable" --url https://raw.githubusercontent.com/IfcOpenShell/bonsai_unstable_repo/main/index.json bonsai_unstable` then `blender --online-mode -b --command extension sync` |
| IfcOpenShell (native) | 0.9.0 (same pin as `python/packages/teldra-ifc`), CPython 3.12.13 | `uv venv --python 3.12 venv && uv pip install --python venv/bin/python ifcopenshell==0.9.0 pytest` (outside the repo) |
| IfcOpenShell (WASM) | 0.9.1+a963c38 modular wheels, cp313 `pyemscripten_2025_0` | https://ifcopenshell.github.io/wasm-wheels/ (see `tools/research/pyodide_wall_experiment.mjs`) |
| Pyodide | 0.29.3 (Python 3.13.2, Emscripten 4.0.9) under Node 24.18.0 | `npm i pyodide@0.29.3` (scratch dir) |
| Sweet Home 3D | 7.6.1 (already installed) | n/a |

Notes:
- The certified reference producer in ADR 0009/0016 is Blender 4.5.14 LTS. Blender 5.3.0 is what Homebrew
  installs today and Bonsai 0.9.0-post1 ran headlessly on it (the extension listing advertises 4.2 LTS, so
  5.x support is empirical, not promised). Certifying Bonsai needs an explicit pin: either 4.5 LTS with the
  0.9.1-alpha build (declared 4.5.0 to 5.1.0) or a separate 5.x certification. Not decided here (#125).
- `ifcopenshell.validate(express_rules=True)` needs `pytest` installed; without it the call raises
  `ModuleNotFoundError: _pytest`.
- No Blender MCP server was installed. Candidate servers execute arbitrary Python inside Blender over a
  socket, I could not establish provenance and update policy for them, and every experiment here was
  scriptable with `blender -b --python`. Revisit only with a pinned, reviewed release.
- Bonsai wheels/extension and Blender are GPL; IfcOpenShell libraries are LGPL-3.0-or-later (ADR 0012).
  Everything installed lives outside the repository.

## 2. Reproduction scripts (committed)

All in `tools/research/`; they take paths as arguments and never write into the repo.

| Script | Purpose |
|---|---|
| `sh3d_inventory.py` | Element/attribute inventory of `Home.xml` in a `.sh3d` |
| `ifc_fixture_audit.py` | Class/relationship inventory, open/iterate/validate timings, wall edit signals |
| `ifcopenshell_wall_experiment.py` | Four-wall room, mitre via `connect_path` + regenerate, door void/fill, opening re-host, corner move, space footprint, validate. Same file runs native and in Pyodide |
| `pyodide_wall_experiment.mjs` | Pyodide + WASM wheel harness for the above and for a real IFC |
| `bonsai_probe.py`, `bonsai_edit_probe.py` | Blender headless: load IFC in Bonsai, list operators, run Bonsai wall operators, move objects and save |
| `ifc_identity_diff.py` | Structural diff: GlobalId, class, name, placement, key relationships, `Teldra_Source` |
| `ifc_crosscheck.py` | IfcOpenShell validation and wall geometry of an IFC written by another engine |

## 3. What the fixtures contain (measured, IfcOpenShell 0.9.0)

| Fixture | Entities | Walls | Voided walls | Openings (with body) | Spaces (with body) | Path connections | Validate (express) |
|---|---|---|---|---|---|---|---|
| golden-home `building.ifc` | 220 | 4 | 1 | 1 (0) | 1 (0) | 0 | 0 errors |
| connected-walls `building.ifc` | 95 | 4 | 1 | 1 (0) | 0 | 1 | 5 errors, all 21-character GlobalIds |
| 21D `building.ifc` (64 MB) | 7,816 | 82 | 12 | 13 (0) | 13 (0) | 0 | 0 errors (4.3 s) |

Consequences: voids are semantic only (wall volume with and without the void is identical in IfcOpenShell,
hence also in Bonsai), spaces have no footprint, there are no slabs, no space boundaries, and the 53 SH3D
wall links in 21D never become `IfcRelConnectsPathElements`. 24 doors/windows are
`IfcBuildingElementProxy`; 21D import warns that 5 had no host wall. Tracked in #160.

21D `Home.xml` inventory [inv]: 82 walls (53 with `wallAtStart/End`, 75 baseboards), 13 rooms, 2 levels,
24 doorOrWindow (16 sashes), 153 pieceOfFurniture, 12 lights (18 light sources), 1 shelfUnit, 1 furnitureGroup,
36 textures, 40 materials, compass, background image, observer camera and photo/video settings. No labels,
dimension lines, polylines, arc or sloped walls. `catalogId` on 129 of 189 furniture/door/window/light
elements (55 distinct ids).

## 4. Matrix

Columns: **SH3D** = Sweet Home 3D 7.6.1, **Blender+Bonsai** = Blender 5.3.0 + Bonsai 0.9.0-post1,
**Teldra now** = `main` at 3c7ae06, **Gap** = what is missing and where it is tracked.

### 4.1 Sweet Home 3D parity

| Capability | SH3D | Blender+Bonsai | Teldra now | Gap |
|---|---|---|---|---|
| 2D plan drafting of walls with snaps, lengths, angles | Core feature, magnetism [doc] | Polyline wall draw operator `bim.draw_polyline_wall` exists [ran: listed]; interactive only | 2D wall draft workspace with CAD constraints (`apps/studio`, #139, #147, #149); model-space snapping (#137) | No dimensions/annotations in plan: #120, #124 |
| Wall properties: thickness, height, sloped, arc, pattern, side colour/texture, baseboards | All [doc]; 21D uses height, thickness, pattern, side colours, 75 baseboards [inv] | Thickness/height via layer sets and wall type; no pattern/baseboard concept | Straight extruded walls only; pattern, side colours, baseboards not parsed (`teldra_sh3d/parser.py`); arcs deferred with warning (ADR 0007) | Parser completeness and loss report: #164; finishes: #123 |
| Wall corners, T-junction, mitre | Walls linked by `wallAtStart/End`, joints drawn in 3D [inv] | `connect_path` writes the relation only; mitre appears after `regenerate_wall_representation`, needs Axis rep + layer set; regeneration is order dependent [ran] | TS writer keeps coupled endpoints coincident, rejects T-junction axis moves, no mitre (`packages/ifc-edit/src/wall.ts`, ADR 0023); 21D import creates 0 connections | #160 (import), #162 (Python regen), #161 (Pyodide reuse), #121 |
| Doors/windows hosted in walls (cut-out, sash, wall distance) | Core; 24 doorOrWindow, 16 sashes, 13 hosted [inv] | `bim.add_door/add_window/add_opening/add_filling/recalculate_fill/flip_fill` exist [ran: listed]; API re-host is manual (remove void rel, `feature.add_feature`) and keeps GlobalIds [ran] | Import: proxies + `IfcOpeningElement` without body; TS writer refuses walls with voids (`hosted-opening`); no insert/move/resize | #160, #121, #119 |
| Rooms, floors, ceilings | Polygons, floor/ceiling colour/texture, area display [inv: 13 rooms, `areaVisible`, `ceilingColor`] | `bim.generate_space`, `generate_spaces_from_walls`, `draw_slab_from_wall`, flooring/ceiling coverings from walls [ran: listed]; headless run produced `IfcSpace` with body but no `ObjectPlacement` (schema violation) and 0 `IfcRelSpaceBoundary` | Rooms become semantic `IfcSpace` without body; no slab; floors only exist as SH3D visual mesh in GLB | #160, #121, #123 |
| Furniture catalog and imported 3D models | Catalog, `catalogId`, model import, `creator`, `license` [inv] | IFC types/libraries; no SH3D catalog | `catalogId`, creator, license not parsed; furniture mapped to `IfcFurniture` with Teldra_Source provenance; visual via SH3D-produced GLB (ADR 0020) | #122, #164 |
| Furniture transform: move, rotate, pitch/roll, resize, mirror, elevation | Core [inv: `angle`, `pitch`, `roll`, `elevation`, `modelMirrored`] | Object transform; `bim.save_project` wrote exactly the 2 moved placements and nothing else [ran, 21D] | Move, rotate and restricted non-uniform scale of IFC mapped instances (ADR 0021, #82 open); pitch/roll not editable | #82, #135 |
| Groups and shelf units | `furnitureGroup`, `shelfUnit` [inv] | Aggregates/assemblies | Group leaves imported with absolute placement, group itself not preserved | #164 |
| Materials, colours, textures per object | Per-material overrides, 36 textures, 40 materials [inv] | Materials/styles | Original appearance carried in GLB `teldraSourceMaterial` (ADR 0020); not editable, `Sh3dMaterial` only | #123 |
| Levels | 2 levels, elevation, floor thickness, visibility [inv] | Storeys | Levels become `IfcBuildingStorey`; hidden level visibility is renderer-only (ADR 0020) | covered |
| Lights | 12 lights, power, 18 light sources [inv] | Not SH3D-compatible | `IfcLightFixture` + twin binding; interactive lighting profile (ADR 0020) | #135 |
| Compass, north, geolocation | `compass` with lat/long/timezone/north [inv] | `bim.add_georeferencing`, `edit_georeferencing` [ran: listed] | Not parsed from SH3D; building site-frame math exists (#130, #146) | #128, #164 |
| Cameras, virtual visit, photo/video | Observer + top camera, photo/video quality [inv] | Cycles render (#52 certified) | Cameras kept as presentation data, not canonical | covered |
| Dimension lines, labels, polylines | Supported [doc]; none in 21D | Drawings and annotations (Bonsai drawing tools) | Not parsed | #124, #164 |
| Background image tracing | `backgroundImage` [inv] | Reference images (not tested) | Not parsed | #164 |
| Undo/redo, multi-select, align | Core [doc] | Blender undo; IFC changes through Bonsai operators | Command history with byte-identical undo for wall and furniture editors (ADR 0014, `IfcWallEditor`) | #135 end-to-end scenario |
| Export / interchange | OBJ, plan PDF/SVG, images [doc] | IFC, glTF, drawings | `.teldra` + IFC + GLB; no SH3D writer (non-goal in #4) | none; intentional |

### 4.2 Blender + Bonsai editing behaviour (what was actually run)

| Capability | Blender+Bonsai [ran] | Teldra now | Gap |
|---|---|---|---|
| Open Teldra IFC | golden-home loads in 0.2 s (12 Blender objects); 21D in 3.0 s (290 objects, 2.1 GB peak RSS, 12 s wall including start-up) | n/a | none |
| Load + save roundtrip identity | 0 GlobalIds removed/added, 0 class/name/placement/relationship changes, `Teldra_Source` psets preserved, both fixtures (`ifc_identity_diff.py`) | n/a | Automate in CI: #163, #125 |
| Edit and save | Moving one wall and one chair in Blender then `bim.save_project` changed exactly those two placements. Without save (`f.write` directly) nothing changed: placement sync happens in the save operator | n/a | Document in #125 harness; do not call `ifc.write` directly |
| Wall join/unjoin/recalculate/split operators | `unjoin_walls`, `join_walls_intersection`, `recalculate_wall`, `split_wall` all FINISHED headless on an Axis+layer-set model; GlobalIds stable; split created one new wall with a new GlobalId | TS editor has none of these | #161/#162 or Bonsai-side authoring (#125) |
| Space generation headless | `generate_spaces_from_walls` and `generate_space` created `IfcSpace` with body but without `ObjectPlacement`; `ifcopenshell.validate` flags both. UI operators are not a safe headless API | n/a | Use `ifcopenshell.api`, never UI operators, for automation: #162 |
| Hosted-opening cut | Voids with no opening body never cut (IfcOpenShell geometry identical with/without void). With a body, door void removed exactly 0.378 m3 (0.9 x 0.2 x 2.1) | n/a | #160 |
| Wall regeneration after endpoint move | Two-pass regeneration needed; single pass left the neighbour wall at x=5.1 instead of 6.128 | TS propagates coupled endpoints transitively and rejects a collapsing neighbour | #162 |
| Validation | `ifcopenshell.validate` on 21D 4.3 s, 0 errors; on Bonsai/IfcOpenShell-authored scratch models 0 errors (except the headless-space placement above) | Only web-ifc re-open tests | #163 |
| Cross-check of Teldra TS writer | Writer output (move connected endpoint + create wall) validated with 0 structural errors in IfcOpenShell; geometry consistent; only the fixture's 5 bad GlobalIds failed (`ifc_crosscheck.py`) | Writer shipped in #155 | Add as CI gate: #163 |
| Geometry iteration cost | 21D full model: 39.6 s on 10 threads, 777,511 triangles (mostly furniture meshes); 82 walls only: 0.09 s | GLB derived from SH3D export, not IfcOpenShell (ADR 0008 says IfcOpenShell GLB for baseline) | Use wall-only regeneration; do not re-triangulate furniture |

## 5. Answer to the coordinator: reuse IfcOpenShell instead of reimplementing in TypeScript?

**Recommendation: yes for topology-sensitive operations, but as a lazily loaded engine behind the existing
adapter seam, not as a rewrite of what already ships.** Keep `@teldra/ifc-edit` (#155) for simple edits.
Do not extend it with mitring, hosted-opening re-hosting, T-junction recomputation or space recomputation;
implement those once on IfcOpenShell and run the same Python in two places:

1. Native (CLI, desktop shell, CI, optional local service): IfcOpenShell 0.9.0 from `python/`, already pinned
   and already used by `teldra-ifc` and the archive CLI. This is the authority for certification (#125).
2. Browser Studio: the same Python in a Pyodide Web Worker, loaded on first use of such an edit.

Evidence that the browser route is real, not theoretical [ran]:

| Measurement (Node host, single thread) | Value |
|---|---|
| Identical result native vs WASM | Same wall volumes, bounding boxes, GlobalIds, void cut 0.378 m3, validate 0 errors |
| Pyodide boot + IfcOpenShell wheel install + import | 0.9 s + 0.6 s + 0.3 s (local files; wheels re-tagged) |
| Download | IfcOpenShell wheels 12.7 MB (core 3.2, IFC4 schema 0.6, OpenCascade kernel 5.4, CGAL kernel 1.8, mapping, pure python); Pyodide wasm 8.3 MB + stdlib 2.3 MB + numpy 3.0 MB + shapely 0.8 MB; about 27 MB raw, cacheable by the PWA |
| 21D `building.ifc` (64 MB) | opens in 2.1 s, 82 walls triangulated in 0.1 s (native: 0.4 s and 0.09 s) |
| Wall experiment end to end | 4.5 s in WASM including 1.7 s validation (native validation 0.9 s) |

Why not just port to TypeScript on web-ifc: web-ifc is a parser/geometry reader with a low-level writer; the
mitre, layer-set regeneration, void/fill, space and validation logic is what IfcOpenShell's API already
encodes, and the maintainers ship it in the same wheel Bonsai uses. Reimplementing duplicates exactly the
behaviour #125 must certify against Bonsai.

Constraints and risks found (each needs an owner before relying on it):

- **IfcOpenShell is not a drop-in for Teldra's walls.** `connect_path` only writes the relation; geometry changes
  only when `regenerate_wall_representation` runs, which needs an `Axis` representation and a material layer
  set usage. None of the 82 imported walls has either. Regeneration is order dependent (two passes). There is no
  re-host function and no space recompute in the API. The Teldra wall convention (rectangle from the axis side,
  ADR 0023) must be reconciled with layer-set offset. Tracked: #162.
- **The IFC itself must carry what an engine needs.** Openings and spaces have no bodies, so even IfcOpenShell
  cannot cut walls from the current 21D IFC. This is the most important blocker. Tracked: #160.
- **WASM wheels are provisional.** They are IfcOpenShell-org "test wheels" outside PyPI (PEP 783 pending),
  version 0.9.1+a963c38 rather than the 0.9.0 pin, and tagged `pyemscripten_2025_0`, which Pyodide 0.29.3 only
  accepted after renaming to `pyodide_2025_0`. Requires hash-pinned self-hosting and a provenance entry (ADR 0016).
- **Not measured:** real-browser timings (Node only), memory ceiling of WASM for very large files, Firefox/WebKit,
  mobile devices, service-worker caching, CSP `wasm-unsafe-eval`. No threads in WASM. Tracked: #161.
- **Licensing:** IfcOpenShell is LGPL-3.0-or-later. Shipping it as separately replaceable wheel files fetched at
  runtime is the plausible compliant shape, but a WASM bundle is novel; it needs the review ADR 0012 already
  demands before release. Bonsai/Blender code stays in the GPL zone and is only a certification oracle and optional
  authoring tool. Pyodide's own licence was not re-verified here.
- **Do not use Bonsai UI operators as an automation API.** Headless they work (join, split, recalc) but spaces were
  created without placement, and object transforms only reach IFC inside `bim.save_project`.
  Automation should call `ifcopenshell.api` and use Bonsai only for interactive authoring and as a roundtrip oracle.
- A local Teldra Python service remains an option for desktop shells, but is the weakest fit for the PWA/offline
  goals (ADR 0022); keep it as the fallback, not the primary design.

## 6. Gap register

Issues #119 to #135 already track the authoring, plan, library, finishes, documentation, georeference, tiles,
WebMCP, agent and photo items; they are linked above instead of duplicated. New issues from this research:

| Issue | Gap |
|---|---|
| #160 | SH3D import: opening bodies, typed doors/windows, space footprints, wall path connections |
| #161 | Spike: IfcOpenShell in Pyodide worker, go/no-go with licence review |
| #162 | `teldra-ifc`: wall join/regenerate, opening re-host, space recompute service |
| #163 | IfcOpenShell validation/cross-check in CI; fix 21-character fixture GlobalIds |
| #164 | SH3D parser completeness contract and loss report |

Not filed because already covered: Blender/Bonsai version pin and headless harness (#125 acceptance), 2D plan
dimensions and annotations (#120, #124), furniture catalog (#122), finishes (#123), georeference (#128),
end-to-end 21D scenario (#135).
