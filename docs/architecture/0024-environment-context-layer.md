# ADR 0024: Environment context layer (terrain, neighbours, roads, vegetation)

Status: proposed (draft for #129; see `docs/research/geo-environment-sources.md` for source evidence)

## Context

Teldra needs surroundings for orientation, sun/shadow studies and realism: terrain, neighbouring buildings,
roads, trees, water. Candidate sources have mixed licences, mixed accuracy and mostly cannot be fetched by a
browser directly. None of it is architectural evidence.

## Decision

### 1. Separate derived layer, never IFC

Environment data is a **derived, non-canonical projection** (ADR 0001, 0002). It is not written to IFC, not
part of the twin format, and has no IFC GlobalIds or Teldra canonical ids. Environment objects carry an
`envId` in their own namespace (`env:<provider>:<externalId>`) that resolves only to the source record.
Environment geometry can be deleted and regenerated at any time without changing a project.
A project stores only a small *environment spec* in the project format (provider choices, extent, the
anchor, attribution and licence records, source dataset versions); never the geometry as authority.

### 2. Local ENU frame anchored at the site placement

All environment meshes are in a local **ENU** frame (East, North, Up; metres; right-handed; Z-up) whose
origin is the site's georeference (WGS84 lat/lon/ellipsoidal height) taken from the IFC/project spatial
contract (ADR 0005). Conversions are explicit and tested (`wgs84ToEnu` in `@teldra/projection`, exact
ECEF-based, no planar shortcut). Source CRSs (SWEREF99 TM / EPSG:5845, EPSG:4326) are converted in the prep
step; EPSG codes and vertical datum (RH2000 vs ellipsoid, geoid offset) are recorded in the tile source
record. Renderer origin shifting, camera and filtering never rewrite the anchor. The ENU-to-scene transform
reuses the scene-manifest convention (ADR 0008).

### 3. Tiles, LOD, caching, spatial index

- `EnvironmentTile` (`packages/projection`): provider-independent, versioned (`schemaVersion`), carries frame,
  source record (licence, attribution, retrievedAt, dataset version), LOD, ENU bounds, meshes, diagnostics.
- Tiling is a regular grid in ENU (e.g. 256 m / 1 km / 4 km per LOD), keyed `tileId = lod/x/y`; a quadtree
  over the ENU extent is the spatial index. Tiles load by distance from the site, nearer = finer LOD.
- Prep pipeline (CLI/server, credentials stay there): fetch -> clip to extent -> convert to ENU -> procedural
  meshing -> write tiles + manifest to an artifact cache keyed by (provider, dataset version, extent, converter
  version). Browser runtime only loads prepared tiles (static files, HTTP caching, IndexedDB/OPFS optional).
  This respects Geotorget auth and Overpass fair use.
- Only license-permitting sources are cached (OSM/Overture/Lantmäteriet/Copernicus). Google/Cesium tiles are
  never cached, extracted, or used as shadow geometry.

### 4. Procedural buildings with provenance

Buildings are extruded from footprint + `height` / `building:levels` x m-per-level (/ Overture `height`,
`num_floors`, `min_height`), flat roof by default; roof shapes are an LOD refinement later. Every mesh records
`provenance.geometryClass` (`measured` | `reconstructed` | `estimated`) and the attribute that produced its
extent (`heightBasis`, `widthBasis`). Defaults are `estimated` and must be visible in the UI and in any
shadow-study report. Input that cannot be meshed (open rings, holes, self-intersection) is reported in tile
`diagnostics`, never silently repaired.

Terrain: Lantmäteriet 1 m DTM near the site, Copernicus GLO-30 as wide-area/fallback (a surface model, so
flagged). Roads/paths are flat ribbons marked `drapeOnTerrain`; the adapter drapes them onto the terrain.

### 5. Shadow-caster participation

Each mesh has `castsShadow`. Buildings and (later) trees cast; roads, paths and ground do not. Terrain
receives and casts. Environment casters join the sun/shadow pass as a separate group from the building's own
meshes so they can be toggled and so a result can state "excluding neighbours" or "estimated neighbours
included". Environment meshes are never occluders for picking or editing by default.

### 6. Renderer plug-in without editing coupling

`@teldra/projection` owns the tile contract and pure converters (no Babylon, deck.gl, Solid, Lit, network).
`runtime-babylon` gets an `EnvironmentLayer` adapter: tile in -> meshes under a root node with an explicit
ENU->scene transform, shadow-caster registration, attribution surface, unload on LOD change. `runtime-deck`
gets a map-context adapter (terrain/footprint layers) from the same tiles. Both are plain TypeScript and
independent of editing state: no command, selection, IFC edit or history path touches environment tiles, and
environment nodes are non-pickable for edit tools. Studio exposes a toggle and an attribution/provenance
panel; the layer is optional and a project works fully without it.

## Consequences

- Licensing is explicit per tile (`source.licence`, `source.attribution`) and displayed while visible;
  ODbL share-alike stays contained in a separable layer.
- Core-layer dependency direction holds: schemas -> domain -> projection (tile contract) -> adapters.
- Costs: a prep pipeline and credential handling for Geotorget; unresolved terms for Lantmäteriet Byggnad,
  Malmö 3D and Esri (see research doc).
- Prototype in this change: `EnvironmentTile` contract, `wgs84ToEnu`, and `osmWaysToEnvironmentTile`
  (buildings + roads/paths) with unit tests on a synthetic fixture. Not included: terrain, vegetation,
  holes/multipolygons, roof shapes, tiling/indexing, runtime adapters, fetching.

## Follow-ups

1. Resolve open licence questions; decide Byggnad/Overture cross-check policy.
2. Environment spec in the project format (schema review) and attribution UI.
3. Prep CLI (Overpass/Overture/STAC) with fixture-based tests; terrain tiles from COG.
4. Babylon `EnvironmentLayer` with real-browser tests for transform and shadow participation.
