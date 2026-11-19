import { describe, expect, it } from "vitest";
import {
  SitePlacementError,
  assertSitePlacement,
  assertTwinIntegrity,
  type SitePlacement,
  type TwinProject,
} from "../src/index.js";

function placement(overrides: Partial<SitePlacement> = {}): SitePlacement {
  return {
    anchor: {
      crs: "EPSG:4326",
      latitudeDegrees: 55.613,
      longitudeDegrees: 12.976,
      height: { metres: 40, reference: "ellipsoidal" },
    },
    orientation: { northReference: "geographic-north", projectNorthBearingDegrees: 12.5 },
    provenance: {
      status: "provisional",
      source: "osm-overpass",
      dataset: "OpenStreetMap",
      retrievedAt: "2026-01-02T03:04:05Z",
    },
    ...overrides,
  };
}

function twin(sitePlacement?: SitePlacement): TwinProject {
  return {
    schemaVersion: "0.1.0",
    building: { ifcSchema: "IFC4", refs: [], ...(sitePlacement ? { sitePlacement } : {}) },
    devices: [],
    bindings: [],
  };
}

describe("site placement contract", () => {
  it("accepts provisional and user-confirmed placements", () => {
    expect(() => assertSitePlacement(placement())).not.toThrow();
    expect(() =>
      assertSitePlacement(
        placement({
          provenance: { ...placement().provenance, status: "user-confirmed", confirmedAt: "2026-01-03T00:00:00Z" },
        }),
      ),
    ).not.toThrow();
  });

  it("is checked as part of twin integrity", () => {
    expect(() => assertTwinIntegrity(twin(placement()))).not.toThrow();
    const bad = placement({ orientation: { northReference: "geographic-north", projectNorthBearingDegrees: 360 } });
    expect(() => assertTwinIntegrity(twin(bad))).toThrow(SitePlacementError);
  });

  it("rejects out-of-range or non-finite anchors", () => {
    const anchor = placement().anchor;
    for (const mutated of [
      { ...anchor, latitudeDegrees: 91 },
      { ...anchor, longitudeDegrees: Number.NaN },
      { ...anchor, height: { metres: Number.POSITIVE_INFINITY, reference: "ellipsoidal" as const } },
    ]) {
      expect(() => assertSitePlacement(placement({ anchor: mutated }))).toThrow(SitePlacementError);
    }
  });

  it("requires a named vertical datum for orthometric heights", () => {
    const anchor = placement().anchor;
    expect(() =>
      assertSitePlacement(placement({ anchor: { ...anchor, height: { metres: 2, reference: "orthometric" } } })),
    ).toThrow(/vertical datum/);
    expect(() =>
      assertSitePlacement(
        placement({ anchor: { ...anchor, height: { metres: 2, reference: "orthometric", verticalDatum: "RH2000" } } }),
      ),
    ).not.toThrow();
  });

  it("requires confirmation time exactly when the status is user-confirmed", () => {
    const base = placement().provenance;
    expect(() => assertSitePlacement(placement({ provenance: { ...base, status: "user-confirmed" } }))).toThrow(/confirmedAt/);
    expect(() =>
      assertSitePlacement(placement({ provenance: { ...base, confirmedAt: "2026-01-03T00:00:00Z" } })),
    ).toThrow(/confirmedAt/);
  });
});
