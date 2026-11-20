# Site placement

Status: provisional design, implemented for issues #128 and #129. Placements produced by the tooling are
`provisional` until a user confirms them; no placement is committed as verified.

## Contract

`twin.building.sitePlacement` (optional, additive to twin schema 0.1.0; no version bump or migration is required
because documents written before the field existed remain valid and parse unchanged, see
`packages/project-format/test/site-placement.test.ts`).

- `anchor`: WGS84 (`EPSG:4326`) latitude/longitude of the IFC local origin, plus `height`. The height reference is
  explicit: `ellipsoidal` (above the WGS84 ellipsoid) or `orthometric` (named `verticalDatum` required; a recorded
  `geoidSeparationMetres` is required before the application derives an ellipsoidal height; it is never guessed).
- `orientation`: `northReference` is always `geographic-north`; `projectNorthBearingDegrees` is the clockwise bearing of
  building local +Y (project north) from true north in [0, 360). It equals the clockwise yaw used by
  `buildingLocalToEcef`.
- `provenance`: `status` (`provisional | user-confirmed`), `source`, `dataset`, `retrievedAt`, optional
  `sourceObjectId`, `attribution`, and `confirmedAt` (present exactly when user-confirmed).

Mutation goes through the `twin.building.place-site` application command (`TwinEditor.placeBuildingSite`), which is
undoable. IFC geometry and Teldra canonical IDs are never touched.

## Layers

| Piece | Location |
| --- | --- |
| Schema, semantic checks | `schemas/json/twin.schema.json`, `packages/domain` (`assertSitePlacement`) |
| Anchor bridge, confirm, command | `packages/application` (`site-placement.ts`, `twin-editor.ts`) |
| Candidate contract, footprint alignment | `packages/application` (`site-candidates.ts`, `footprint-alignment.ts`) |
| OSM Overpass adapter | `integrations/osm-overpass` |
| Panel, map model | `apps/studio/src/SitePlacementPanel.tsx`, `site-placement-model.ts` |

Environmental geography (candidates, basemap tiles) is rendered in a separate SVG map. The IFC footprint appears only
as a derived, read-only overlay computed from the current draft; nothing on the map edits IFC geometry.

## Studio integration

Mounted: the Studio app bar has a **Site** button (icon-only in compact layouts) that opens `StudioSiteDialog`, a modal host
for `<SitePlacementPanel>` (full screen on compact widths). The modal keeps the 3D viewport mounted and untouched.

- `StudioProjectController.placeBuildingSite(placement | null)` delegates to the `TwinEditor`, so the placement shares the twin
  undo/redo history, dirty state, save and reopen with every other twin edit.
- `StudioSitePanel` adapts controller state to the headless panel (confirm, undo, redo, save project). Latitude, longitude,
  elevation and bearing are independently editable; manual entry needs no network.
- Footprint overlay: `BrowserStudioProject.readSiteFootprint()` reads wall axes from the canonical IFC
  (`readWallFootprintSegments` in `@teldra/ifc-edit`, read-only) and builds the convex outline with `convexFootprintFromWalls`.
  Concave plans use the convex hull until a slab/space outline reader exists; the residual is reported, never hidden.
- Overpass is opt-in: nothing is requested until the user presses "Find buildings". One shared `OverpassBuildingSource` per
  panel provides caching, de-duplication, throttling and a generic User-Agent.

## Test data

All site fixtures and tests are synthetic: `fixtures/osm/overpass-buildings-bbox.json` is hand-authored, Overpass-shaped data for a
made-up block near 0.5 N 0.5 E with synthetic ids (way/1000001.., relation/2000001). It is not derived from real OSM data and
ODbL does not apply to it. No committed fixture, test or story may use the coordinates or OSM ids of a real private site.

## Data source evaluation (findings, not integrations)

| Source | Use | Licence / terms | Verdict |
| --- | --- | --- | --- |
| OSM via Overpass | Building outlines, `building:levels`, sometimes `height` | ODbL 1.0, attribution required. Public instance is for light interactive use; it was at capacity (HTTP 502/504) during development, so callers must expect failure and cache | Integrated (adapter, bbox only, cached, throttled, generic User-Agent) |
| OSM raster tiles | Reference basemap | Attribution required; OSMF tile usage policy forbids heavy or offline-bulk use, needs a valid identifying client | Bundled as the only default basemap, off until the user selects it |
| Lantmäteriet open data (Markhöjdmodell grid 1 m, laser data) | Terrain heights | Published as open geodata under CC0 | Best terrain source; not integrated (large rasters; needs a download or service step) |
| Lantmäteriet orthophoto | Aerial imagery | Reported as CC0 only for historical orthophotos; the current product has separate terms of use and token-based services. Unresolved: confirm per product before any browser use | Not bundled; host may supply a `BasemapConfig` once terms are confirmed |
| Lantmäteriet Byggnad / Fastighetskartan | Authoritative building footprints | Open-data availability varies by product; verify before use | Not evaluated in depth; likely better footprints than OSM where open |
| Malmö stad 3D city model | Building heights, DSM/DTM, roofs | Ordered extracts rather than an open download; terms not found publicly | Not integrated; ask the city for terms if heights matter |
| Malmö stad open data portal | Misc. municipal datasets | CC licences per dataset | No building footprint or height dataset found in a quick search |
| Esri / Google / Bing imagery | Aerial imagery | Terms generally restrict use outside their SDKs or require keys and billing | Not used |

Roads: OSM `highway` ways are available through the same Overpass adapter pattern (not implemented). Lantmäteriet and
Trafikverket (NVDB) hold authoritative road data under open licences, to be verified when needed.

Search method and caveats: licences above come from a brief web search and Lantmäteriet product pages, and some
community-forum statements conflict; treat every row as needing confirmation against the provider's current terms.
