import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import type { SitePlacement, TwinProject } from "@teldra/domain";
import {
  CommandTransactionError,
  TwinEditor,
  buildingLocalToEcef,
  canonicalTwinFingerprint,
  confirmSitePlacement,
  ecefToGeodetic,
  geodeticAnchorFromSitePlacement,
  geodeticToEcef,
} from "../src/index.js";

const fixture = goldenTwin as unknown as TwinProject;

function placement(): SitePlacement {
  return {
    anchor: {
      crs: "EPSG:4326",
      latitudeDegrees: 55.613,
      longitudeDegrees: 12.976,
      height: { metres: 40, reference: "ellipsoidal" },
    },
    orientation: { northReference: "geographic-north", projectNorthBearingDegrees: 90 },
    provenance: { status: "provisional", source: "osm-overpass", dataset: "OpenStreetMap", retrievedAt: "2026-01-02T03:04:05Z" },
  };
}

describe("ecefToGeodetic", () => {
  it("inverts geodeticToEcef to sub-micro-degree precision, including poles, antimeridian and depth", () => {
    for (const [lat, lon, h] of [[55.613, 12.976, 40], [0, 0, 0], [-78, 179.9, -20], [89.9, -179.99, 300], [-89.99, 10, 5]] as const) {
      const out = ecefToGeodetic(geodeticToEcef(lat, lon, h));
      expect(Math.abs(out.latitudeDegrees - lat)).toBeLessThan(1e-9);
      expect(Math.abs(out.longitudeDegrees - lon)).toBeLessThan(1e-9);
      expect(Math.abs(out.ellipsoidalHeightMetres - h)).toBeLessThan(1e-5);
    }
  });
});

describe("geodeticAnchorFromSitePlacement", () => {
  it("maps ellipsoidal placements and converts the bearing to the existing clockwise-yaw convention", () => {
    const anchor = geodeticAnchorFromSitePlacement(placement());
    expect(anchor).toEqual({ latitudeDegrees: 55.613, longitudeDegrees: 12.976, ellipsoidalHeightMetres: 40, clockwiseYawRadians: Math.PI / 2 });
    // project north (+Y) of the building points east when the bearing is 90 degrees.
    const probe = ecefToGeodetic(buildingLocalToEcef(anchor, [0, 10, 0]));
    expect(probe.longitudeDegrees).toBeGreaterThan(12.976 + 1e-5);
    expect(Math.abs(probe.latitudeDegrees - 55.613)).toBeLessThan(1e-7);
  });

  it("never guesses an ellipsoidal height from an orthometric one", () => {
    const orthometric: SitePlacement = {
      ...placement(),
      anchor: { ...placement().anchor, height: { metres: 3, reference: "orthometric", verticalDatum: "RH2000" } },
    };
    expect(() => geodeticAnchorFromSitePlacement(orthometric)).toThrow(/geoid separation/);
    const withSeparation: SitePlacement = {
      ...orthometric,
      anchor: { ...orthometric.anchor, height: { ...orthometric.anchor.height, geoidSeparationMetres: 36 } },
    };
    expect(geodeticAnchorFromSitePlacement(withSeparation).ellipsoidalHeightMetres).toBe(39);
  });
});

describe("confirmSitePlacement", () => {
  it("marks a placement user-confirmed with a timestamp and leaves the original untouched", () => {
    const original = placement();
    const confirmed = confirmSitePlacement(original, "2026-02-03T04:05:06Z");
    expect(confirmed.provenance.status).toBe("user-confirmed");
    expect(confirmed.provenance.confirmedAt).toBe("2026-02-03T04:05:06Z");
    expect(confirmed.provenance.source).toBe("osm-overpass");
    expect(original.provenance.status).toBe("provisional");
  });
});

describe("TwinEditor site placement command", () => {
  it("places the building through canonical history, restoring absence on undo and the value on redo", () => {
    const editor = new TwinEditor(fixture);
    const before = canonicalTwinFingerprint(editor.twin);
    const confirmed = confirmSitePlacement(placement(), "2026-02-03T04:05:06Z");
    editor.placeBuildingSite(confirmed);
    expect(editor.twin.building.sitePlacement).toEqual(confirmed);
    expect(editor.twin.building.refs).toEqual(fixture.building.refs);
    expect(editor.twin.devices).toEqual(fixture.devices);
    editor.undo();
    expect(canonicalTwinFingerprint(editor.twin)).toBe(before);
    expect(editor.twin.building.sitePlacement).toBeUndefined();
    editor.redo();
    expect(editor.twin.building.sitePlacement).toEqual(confirmed);
  });

  it("undoes a replacement back to the previous placement and can clear it", () => {
    const editor = new TwinEditor(fixture);
    const first = placement();
    const second = { ...placement(), orientation: { ...placement().orientation, projectNorthBearingDegrees: 10 } };
    editor.placeBuildingSite(first);
    editor.placeBuildingSite(second);
    editor.undo();
    expect(editor.twin.building.sitePlacement).toEqual(first);
    editor.placeBuildingSite(null);
    expect(editor.twin.building.sitePlacement).toBeUndefined();
    editor.undo();
    expect(editor.twin.building.sitePlacement).toEqual(first);
  });

  it("copies input so later mutation cannot rewrite canonical placement", () => {
    const editor = new TwinEditor(fixture);
    const input = placement();
    editor.placeBuildingSite(input);
    (input.anchor as { latitudeDegrees: number }).latitudeDegrees = 1;
    expect(editor.twin.building.sitePlacement?.anchor.latitudeDegrees).toBe(55.613);
  });

  it("rejects invalid placements without committing", () => {
    const editor = new TwinEditor(fixture);
    const bad = { ...placement(), orientation: { ...placement().orientation, projectNorthBearingDegrees: 400 } };
    expect(() => editor.placeBuildingSite(bad)).toThrow(CommandTransactionError);
    expect(editor.revision).toBe(0);
    expect(editor.twin.building.sitePlacement).toBeUndefined();
  });
});
