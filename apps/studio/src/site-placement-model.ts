import {
  buildingLocalToEcef,
  ecefToGeodetic,
  enuToEcef,
  type GeoPoint,
  type LocalPoint,
} from "@teldra/application";
import { assertSitePlacement, type SitePlacement } from "@teldra/domain";

/**
 * Headless model for the Site placement panel. Everything here is a read-only
 * projection or an editable draft; canonical placement only changes through
 * the TwinEditor "twin.building.place-site" command.
 */

const TILE = 256;
const RAD = Math.PI / 180;
const MAX_LAT = 85.0511287798;

export interface MapSize { readonly width: number; readonly height: number }
export interface MapView { readonly centerLatitudeDegrees: number; readonly centerLongitudeDegrees: number; readonly zoom: number }
export interface TileRef { readonly x: number; readonly y: number; readonly z: number; readonly url: string; readonly left: number; readonly top: number }

export function lonLatToWorldPixel(longitudeDegrees: number, latitudeDegrees: number, zoom: number): readonly [number, number] {
  const scale = TILE * 2 ** zoom;
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, latitudeDegrees)) * RAD;
  return [((longitudeDegrees + 180) / 360) * scale, ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * scale];
}

export function worldPixelToLonLat(x: number, y: number, zoom: number): GeoPoint {
  const scale = TILE * 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return { longitudeDegrees: (x / scale) * 360 - 180, latitudeDegrees: (Math.atan(Math.sinh(n)) / RAD) };
}

export function projectToView(view: MapView, size: MapSize, point: GeoPoint): readonly [number, number] {
  const [cx, cy] = lonLatToWorldPixel(view.centerLongitudeDegrees, view.centerLatitudeDegrees, view.zoom);
  const [x, y] = lonLatToWorldPixel(point.longitudeDegrees, point.latitudeDegrees, view.zoom);
  return [x - cx + size.width / 2, y - cy + size.height / 2];
}

export function viewToLonLat(view: MapView, size: MapSize, px: number, py: number): GeoPoint {
  const [cx, cy] = lonLatToWorldPixel(view.centerLongitudeDegrees, view.centerLatitudeDegrees, view.zoom);
  return worldPixelToLonLat(cx + px - size.width / 2, cy + py - size.height / 2, view.zoom);
}

/** Largest integer zoom (<= maxZoom) at which every point sits inside the padded viewport. */
export function fitMapView(points: readonly GeoPoint[], size: MapSize, padding = 16, maxZoom = 19): MapView {
  if (points.length === 0) return { centerLatitudeDegrees: 0, centerLongitudeDegrees: 0, zoom: 1 };
  const lats = points.map((p) => p.latitudeDegrees), lons = points.map((p) => p.longitudeDegrees);
  const centre = { latitudeDegrees: (Math.min(...lats) + Math.max(...lats)) / 2, longitudeDegrees: (Math.min(...lons) + Math.max(...lons)) / 2 };
  for (let zoom = maxZoom; zoom >= 1; zoom--) {
    const view = { centerLatitudeDegrees: centre.latitudeDegrees, centerLongitudeDegrees: centre.longitudeDegrees, zoom };
    const fits = points.every((p) => {
      const [x, y] = projectToView(view, size, p);
      return x >= padding && x <= size.width - padding && y >= padding && y <= size.height - padding;
    });
    if (fits) return view;
  }
  return { centerLatitudeDegrees: centre.latitudeDegrees, centerLongitudeDegrees: centre.longitudeDegrees, zoom: 1 };
}

export function visibleTiles(view: MapView, size: MapSize, urlTemplate: string): TileRef[] {
  const z = view.zoom;
  const [cx, cy] = lonLatToWorldPixel(view.centerLongitudeDegrees, view.centerLatitudeDegrees, z);
  const originX = cx - size.width / 2, originY = cy - size.height / 2;
  const count = 2 ** z;
  const tiles: TileRef[] = [];
  for (let ty = Math.floor(originY / TILE); ty <= Math.floor((originY + size.height) / TILE); ty++) {
    if (ty < 0 || ty >= count) continue;
    for (let tx = Math.floor(originX / TILE); tx <= Math.floor((originX + size.width) / TILE); tx++) {
      const x = ((tx % count) + count) % count;
      tiles.push({
        x, y: ty, z,
        url: urlTemplate.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(ty)),
        left: Math.round(tx * TILE - originX), top: Math.round(ty * TILE - originY),
      });
    }
  }
  return tiles;
}

/**
 * Raster reference basemap. Basemaps are environmental context only and each
 * must carry the attribution and licence the provider requires.
 */
export interface BasemapConfig {
  readonly id: string;
  readonly label: string;
  readonly urlTemplate: string;
  readonly attribution: string;
  readonly license: string;
  readonly maxZoom: number;
}

export function assertBasemap(basemap: BasemapConfig): void {
  if (basemap.attribution.trim().length === 0) throw new Error(`Basemap "${basemap.id}" requires an attribution.`);
  if (basemap.license.trim().length === 0) throw new Error(`Basemap "${basemap.id}" requires a licence statement.`);
  if (!["{z}", "{x}", "{y}"].every((p) => basemap.urlTemplate.includes(p)))
    throw new Error(`Basemap "${basemap.id}" URL template needs {z}, {x} and {y} placeholders.`);
}

/**
 * OSM standard tiles are the only basemap bundled: they are the licensed
 * fallback (ODbL data, attribution required, light interactive use under the
 * OSMF tile usage policy). Aerial imagery providers must be supplied by the
 * host with confirmed browser-use terms; see docs/architecture/site-placement.md.
 */
export const DEFAULT_BASEMAPS: readonly BasemapConfig[] = [
  {
    id: "osm-standard",
    label: "OpenStreetMap",
    urlTemplate: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
    license: "ODbL 1.0 data; tile usage policy https://operations.osmfoundation.org/policies/tiles/",
    maxZoom: 19,
  },
];

export interface PlacementDraft {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  /** Clockwise bearing of project north (+Y) from geographic north. */
  readonly bearingDegrees: number;
  readonly heightMetres: number;
  readonly heightReference: "ellipsoidal" | "orthometric";
  readonly verticalDatum: string;
  readonly geoidSeparationMetres?: number | undefined;
}

export const normaliseBearing = (degrees: number): number => ((degrees % 360) + 360) % 360;

export function draftFromPlacement(placement: SitePlacement): PlacementDraft {
  const { anchor, orientation } = placement;
  return {
    latitudeDegrees: anchor.latitudeDegrees,
    longitudeDegrees: anchor.longitudeDegrees,
    bearingDegrees: orientation.projectNorthBearingDegrees,
    heightMetres: anchor.height.metres,
    heightReference: anchor.height.reference,
    verticalDatum: anchor.height.verticalDatum ?? "",
    geoidSeparationMetres: anchor.height.geoidSeparationMetres,
  };
}

export function placementFromDraft(draft: PlacementDraft, provenance: SitePlacement["provenance"]): SitePlacement {
  const height: SitePlacement["anchor"]["height"] = { metres: draft.heightMetres, reference: draft.heightReference };
  if (draft.heightReference === "orthometric" || draft.verticalDatum.trim() !== "") height.verticalDatum = draft.verticalDatum.trim();
  if (draft.geoidSeparationMetres !== undefined && Number.isFinite(draft.geoidSeparationMetres)) height.geoidSeparationMetres = draft.geoidSeparationMetres;
  const placement: SitePlacement = {
    anchor: { crs: "EPSG:4326", latitudeDegrees: draft.latitudeDegrees, longitudeDegrees: draft.longitudeDegrees, height },
    orientation: { northReference: "geographic-north", projectNorthBearingDegrees: normaliseBearing(draft.bearingDegrees) },
    provenance: structuredClone(provenance),
  };
  assertSitePlacement(placement);
  return placement;
}

export interface DraftNudge { readonly eastMetres: number; readonly northMetres: number; readonly rotateDegrees: number }

/** Move the anchor in geographic east/north metres and/or rotate the bearing. */
export function nudgeDraft(draft: PlacementDraft, nudge: DraftNudge): PlacementDraft {
  const anchor = { latitudeDegrees: draft.latitudeDegrees, longitudeDegrees: draft.longitudeDegrees, ellipsoidalHeightMetres: 0, clockwiseYawRadians: 0 };
  const moved = ecefToGeodetic(enuToEcef(anchor, [nudge.eastMetres, nudge.northMetres, 0]));
  return {
    ...draft,
    latitudeDegrees: moved.latitudeDegrees,
    longitudeDegrees: moved.longitudeDegrees,
    bearingDegrees: normaliseBearing(draft.bearingDegrees + nudge.rotateDegrees),
  };
}

/** Read-only geographic projection of the IFC footprint under a draft placement. */
export function ifcFootprintOverlay(footprint: readonly LocalPoint[], draft: PlacementDraft): GeoPoint[] {
  const anchor = {
    latitudeDegrees: draft.latitudeDegrees,
    longitudeDegrees: draft.longitudeDegrees,
    ellipsoidalHeightMetres: 0,
    clockwiseYawRadians: draft.bearingDegrees * RAD,
  };
  return footprint.map(([x, y]) => {
    const g = ecefToGeodetic(buildingLocalToEcef(anchor, [x, y, 0]));
    return { latitudeDegrees: g.latitudeDegrees, longitudeDegrees: g.longitudeDegrees };
  });
}
