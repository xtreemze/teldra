import { assertSitePlacement, type SitePlacement } from "@teldra/domain";
import type { GeodeticAnchor } from "./building-georeference.js";

const RAD = Math.PI / 180;

/**
 * Bridge the persisted, provider-independent placement to the math anchor.
 * Bearing of project north (+Y) clockwise from geographic north equals the
 * clockwise yaw used by buildingLocalToEcef. Orthometric heights are only
 * converted when the geoid separation is recorded; it is never guessed.
 */
export function geodeticAnchorFromSitePlacement(placement: SitePlacement): GeodeticAnchor {
  assertSitePlacement(placement);
  const { anchor, orientation } = placement;
  const { height } = anchor;
  let ellipsoidal = height.metres;
  if (height.reference === "orthometric") {
    if (height.geoidSeparationMetres === undefined)
      throw new Error("Orthometric site height needs a recorded geoid separation to derive an ellipsoidal height.");
    ellipsoidal = height.metres + height.geoidSeparationMetres;
  }
  return {
    latitudeDegrees: anchor.latitudeDegrees,
    longitudeDegrees: anchor.longitudeDegrees,
    ellipsoidalHeightMetres: ellipsoidal,
    clockwiseYawRadians: orientation.projectNorthBearingDegrees * RAD,
  };
}

/** Promote a (provisional) placement to user-confirmed; pure, returns a copy. */
export function confirmSitePlacement(placement: SitePlacement, confirmedAtIso: string): SitePlacement {
  const next: SitePlacement = {
    ...structuredClone(placement),
    provenance: { ...placement.provenance, status: "user-confirmed", confirmedAt: confirmedAtIso },
  };
  assertSitePlacement(next);
  return next;
}
