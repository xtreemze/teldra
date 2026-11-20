import { assertSitePlacement, type SiteHeight, type SitePlacement } from "@teldra/domain";
import type { FootprintAlignment } from "./footprint-alignment.js";

export interface GeoPoint {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

/**
 * A provider-independent candidate building outline in WGS84. Environmental
 * geography only: it is evidence for placing the building, never IFC geometry.
 * `outer` is an open ring (the closing vertex is not repeated).
 */
export interface BuildingFootprintCandidate {
  readonly id: string;
  readonly provider: string;
  readonly dataset: string;
  readonly outer: readonly GeoPoint[];
  readonly holes?: readonly (readonly GeoPoint[])[];
  readonly centroid: GeoPoint;
  readonly levels?: number;
  readonly heightMetres?: number;
  readonly buildingType?: string;
  readonly attribution: string;
  readonly license: string;
  readonly retrievedAt: string;
}

export interface BoundingBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

/** Provisional placement derived from an alignment suggestion; the user must confirm it. */
export function sitePlacementFromAlignment(
  alignment: FootprintAlignment,
  candidate: BuildingFootprintCandidate,
  height: SiteHeight,
): SitePlacement {
  const placement: SitePlacement = {
    anchor: {
      crs: "EPSG:4326",
      latitudeDegrees: alignment.anchor.latitudeDegrees,
      longitudeDegrees: alignment.anchor.longitudeDegrees,
      height: { ...height },
    },
    orientation: { northReference: "geographic-north", projectNorthBearingDegrees: alignment.projectNorthBearingDegrees },
    provenance: {
      status: "provisional",
      source: candidate.provider,
      dataset: candidate.dataset,
      sourceObjectId: candidate.id,
      retrievedAt: candidate.retrievedAt,
      attribution: candidate.attribution,
    },
  };
  assertSitePlacement(placement);
  return placement;
}
