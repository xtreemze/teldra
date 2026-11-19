import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import type { TwinProject } from "@teldra/domain";
import {
  CURRENT_TWIN_SCHEMA_VERSION,
  ProjectFormatError,
  parseTwinProject,
  validateTwinProject,
} from "../src/index.js";

const placement = {
  anchor: {
    crs: "EPSG:4326",
    latitudeDegrees: 0.5003,
    longitudeDegrees: 0.5025,
    height: { metres: 3.5, reference: "orthometric", verticalDatum: "RH2000", geoidSeparationMetres: 36.1 },
  },
  orientation: { northReference: "geographic-north", projectNorthBearingDegrees: 12.5 },
  provenance: {
    status: "provisional",
    source: "osm-overpass",
    dataset: "OpenStreetMap",
    sourceObjectId: "osm:way/1",
    retrievedAt: "2026-01-02T03:04:05Z",
    attribution: "© OpenStreetMap contributors (ODbL 1.0)",
  },
};

function withPlacement(value: unknown): TwinProject {
  const base = structuredClone(goldenTwin) as unknown as TwinProject;
  return { ...base, building: { ...base.building, sitePlacement: value } } as TwinProject;
}

describe("site placement persistence", () => {
  it("is an additive optional field: documents saved before it existed parse unchanged at the same version", () => {
    // No migration step is required (and none is registered): twin schema version is unchanged.
    expect(CURRENT_TWIN_SCHEMA_VERSION).toBe("0.1.0");
    const legacy = structuredClone(goldenTwin) as unknown as TwinProject;
    expect(legacy.building.sitePlacement).toBeUndefined();
    expect(parseTwinProject(legacy)).toEqual(legacy);
  });

  it("round-trips a placement through JSON serialization without loss", () => {
    const twin = withPlacement(placement);
    const parsed = parseTwinProject(JSON.parse(JSON.stringify(twin)));
    expect(parsed.building.sitePlacement).toEqual(placement);
    expect(parsed).toEqual(twin);
  });

  it("keeps canonical building references and ids untouched by placement", () => {
    const parsed = parseTwinProject(withPlacement(placement));
    expect(parsed.building.refs).toEqual((goldenTwin as unknown as TwinProject).building.refs);
  });

  it("rejects implicit or malformed contracts", () => {
    const bad = [
      { ...placement, orientation: { ...placement.orientation, northReference: "grid-north" } },
      { ...placement, provenance: { ...placement.provenance, status: "verified" } },
      { ...placement, provenance: { ...placement.provenance, retrievedAt: "yesterday" } },
      { ...placement, anchor: { ...placement.anchor, height: { metres: 3 } } },
      { ...placement, anchor: { ...placement.anchor, crs: undefined } },
      { ...placement, extra: true },
    ];
    for (const candidate of bad) {
      expect(validateTwinProject(withPlacement(candidate)).valid).toBe(false);
    }
  });

  it("applies semantic checks during parse", () => {
    const orthometricWithoutDatum = {
      ...placement,
      anchor: { ...placement.anchor, height: { metres: 3, reference: "orthometric" } },
    };
    expect(() => parseTwinProject(withPlacement(orthometricWithoutDatum))).toThrow(ProjectFormatError);
  });
});
