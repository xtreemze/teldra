# Geospatial environment sources for Sweden / Malmö

Research for #129. Written 2026-11-19. Evidence legend: **[ran]** queried live in this research,
**[doc]** read from the provider's page, **[unverified]** could not be confirmed here; do not rely on it
without a follow-up. Sample queries used only synthetic or unrelated public areas (an Örebro city-centre
box for OSM/STAC); nothing near any private project location, no addresses in any request.

Geometry class: **measured** (sensed/surveyed), **reconstructed** (surveyed 2D + recorded attributes),
**estimated** (footprint/guess + defaults). "Browser" = usable from a static web app without our own server.

## Findings

| Source | Content | Geometry class | Licence / terms | Access, auth, limits | Browser, no server | Caching | Verdict |
|---|---|---|---|---|---|---|---|
| Lantmäteriet Markhöjdmodell Nedladdning (`dtm-cog`) | 1 m bare-earth DTM, Sweden-wide, GeoTIFF COG, EPSG:5845 (SWEREF99 TM + RH2000) | measured (lidar) | STAC collection says **CC-BY-4.0** [ran]; older pages say CC0 [doc]. Treat as CC BY 4.0, attribute Lantmäteriet | STAC `https://api.lantmateriet.se/stac-hojd/v1/` open, no key [ran]. Asset on `dl1.lantmateriet.se` returned **401 Basic auth** [ran]; product must be ordered via Geotorget, credentials needed. Tiles are 10 km x 10 km, ~270 MB each [ran] | **No** for direct download (credentials must not ship to a browser). Yes after a server/CLI step that clips and re-encodes | Allowed with attribution | **Adopt** as terrain source behind an offline prep step |
| Lantmäteriet Ythöjdmodell (`dsm-cog`) and Laserdata skog (`dsm-skoglig-copc`) | Surface model; forest lidar COPC | measured | `other`: separate "Villkor och avgifter" / forest-data terms [ran]; not confirmed free | Same STAC, same download auth | No | Unclear, check terms first | **Defer** (tree/roof heights would be valuable; terms unresolved) |
| Lantmäteriet Ortofoto Nedladdning (`stac-bild`) | Aerial orthophotos, one collection per area-year, 2007..2024 present so current and historical both exist [ran] | measured | **CC-BY-4.0** per collection; catalog notes GDPR assessment of your use and special terms to accept [ran] | `https://api.lantmateriet.se/stac-bild/v1/` open metadata [ran]; downloads assumed same Geotorget auth as heights [unverified] | No (auth, large files) | Allowed with attribution | **Adopt** as optional ground texture via prep step; show capture year |
| Lantmäteriet Byggnad / Fastighetskartan buildings | 2D building polygons | measured (survey) | [unverified] whether open or paid | [unverified] | [unverified] | [unverified] | **Open question**; check Geotorget product list |
| Lantmäteriet 3D city / building models | LOD1-2 models | reconstructed | Not in the open-data set [unverified]; Geotorget products are paid | Order via Geotorget | No | Contract-bound | **Reject** for default; revisit per project |
| Malmö stad open data (`opendata.malmo.se`) | Parks, squares, water surfaces, water temps; "free to reuse, modify, share" [doc] | measured/reconstructed (2D) | No licence name on the page [doc] | Portal catalogue, RDF/JSON-LD export | Likely (GeoJSON/CSV) | Presumably | **Candidate** for parks/water; no 3D model or building footprints listed, so a Malmö 3D city model is [unverified] |
| OpenStreetMap (Overpass / extracts) | buildings (`building`, `height`, `building:levels`, `roof:*`, `min_height`), `highway`/`footway` with `width`/`lanes`/`surface`, `landuse`/`natural`/trees, water | reconstructed where height/levels tagged, else estimated | **ODbL 1.0**, attribution "© OpenStreetMap contributors"; substantial extractions used publicly are derivative databases (share-alike), produced works need attribution only [doc] | `https://overpass-api.de/api/interpreter`, no key [ran]. Fair use: <10k queries/day, <1 GB/day, identify with User-Agent/Referer, no parallel scripts, 429/406 backoff 30 s; returned 502 "at capacity" once, then succeeded [ran/doc]. Commercial use needs own/paid instance | Yes (CORS) for small bboxes, but unreliable; prefer pre-built tiles | Allowed; keep attribution and ODbL notice | **Adopt** as primary buildings/roads/vegetation/water source |
| Overture Maps buildings | Buildings + `building_part`; `height`, `num_floors`, `roof_shape`, `roof_material`, `min_height`, `is_underground`; sources OSM, Esri Community Maps, ML roofprints | reconstructed/estimated; ML parts estimated | **ODbL** (buildings theme) [doc] | Monthly releases, `s3://overturemaps-us-west-2/release/<ver>/theme=buildings/type=building/*` and Azure mirror, no auth [doc]. Release 2026-11-18.0 [doc] | Not directly (columnar parquet; needs DuckDB/prep or PMTiles extract) | Allowed under ODbL | **Adopt** as secondary/cross-check, fills ML gaps; Sweden is OSM-dominated |
| Google Photorealistic 3D Tiles | Textured photogrammetry mesh | measured (photogrammetry) | Google Maps Platform terms: visualization only; no extraction, no derived 3D/terrain models, no analysis; honour Cache-Control only; Google logo + aggregated `asset.copyright` attribution [doc] | Google Cloud key, billing | Yes (online only) | **No** beyond HTTP cache semantics | **Reject** as geometry or shadow source; at most an online-only display layer. Our own overlays must not derive from it |
| Cesium ion (World Terrain, OSM Buildings, Google passthrough) | Hosted terrain/buildings tiles | measured/reconstructed | No copying/storing for offline use; only general-purpose caching; Cesium logo; third-party appendices apply [doc] | ion token, plan quotas | Yes, online | Restricted | **Reject** as dependency (offline and project export forbidden) |
| Esri (World Imagery, 3D basemaps, Community Maps) | Imagery, basemap | measured | Terms in product-specific terms (E300); page text not retrievable [unverified] | API key | Yes, online | [unverified] | **Defer** until terms read; imagery is not needed for MVP |
| Copernicus DEM GLO-30 | ~30 m global **surface** model (includes buildings/vegetation); abs. vertical <4 m (90%) | measured, coarse | Copernicus free licence; mandatory notice "provided under COPERNICUS by the European Union and ESA; all rights reserved" + DLR/Airbus lines; "Produced using Copernicus WorldDEM-30" when modified [doc] | AWS Open Data `copernicus-dem-30m`, eu-central-1, COG, `--no-sign-request` [doc] | Yes (COG range reads, S3 CORS to verify) | Allowed with notice | **Adopt as fallback** terrain outside Swedish lidar coverage and for wide context; too coarse for the site |
| EU-DEM / EEA-10 | 25 m legacy / 10 m European DEM | measured | EEA-10 10 m access limited to a user subset under CCM licence [doc]; EU-DEM not covered by the page read [unverified] | Copernicus Land / CDSE registration | No | Terms-bound | **Reject** (superseded by GLO-30 for our use) |

## Key observations

1. The best Swedish terrain data is free (CC BY 4.0) but sits behind Geotorget credentials, so it cannot be
   fetched by a browser app directly. A prep step (CLI or server, credentials in env) must clip, resample
   and publish project-local tiles. This also fits ADR 0001: environment tiles are derived artifacts.
2. Licence conflict to resolve before shipping: the STAC collection says CC BY 4.0, older Lantmäteriet text
   says CC0. Attribute either way.
3. Photorealistic tile services forbid exactly what shadow analysis needs (extraction, caching), so shadow
   casters come from procedural OSM/Overture/lidar geometry only.
4. OSM height coverage is the limiting factor for shadows. Estimated heights must stay visibly flagged.
5. ODbL share-alike applies to derivative databases. Bundling an OSM extract inside a shared project file
   makes that file's environment part ODbL; keep it a separable, attributed, regenerable layer.
6. Open questions: Lantmäteriet Byggnad terms, Malmö 3D model existence/terms, Esri terms, orthophoto
   download auth, S3 CORS for Copernicus COGs.
