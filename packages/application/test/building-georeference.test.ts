import { describe, expect, it } from "vitest";
import {
  assertGeodeticAnchor, buildingLocalToEcef, ecefToBuildingLocal,
  ecefToEnu, enuToEcef, geodeticToEcef,
  type GeodeticAnchor,
} from "../src/building-georeference.js";

const malmo: GeodeticAnchor = {
  latitudeDegrees: 55.605, longitudeDegrees: 13.0038,
  ellipsoidalHeightMetres: 38, clockwiseYawRadians: 0,
};
const near = (actual: readonly number[], expected: readonly number[], tolerance = 1e-6) => {
  for (let i = 0; i < 3; i++) expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThan(tolerance);
};

describe("building georeference", () => {
  it("produces canonical WGS84 ECEF landmarks", () => {
    near(geodeticToEcef(0, 0, 0), [6378137, 0, 0]);
    near(geodeticToEcef(0, 90, 0), [0, 6378137, 0]);
    near(geodeticToEcef(90, 0, 0), [0, 0, 6356752.314245], 1e-3);
  });

  it("roundtrips ENU metre offsets with sub-millimetre numerical error", () => {
    for (const offset of [[0, 0, 0], [100, -50, 12], [-5000, 800, -20]] as const) {
      near(ecefToEnu(malmo, enuToEcef(malmo, offset)), offset);
    }
  });

  it("rotates local building axes clockwise to true north without altering the original point", () => {
    const anchor = { ...malmo, clockwiseYawRadians: Math.PI / 2 };
    const original = [4, 10, 3] as const;
    const ecef = buildingLocalToEcef(anchor, original);
    near(ecefToEnu(anchor, ecef), [10, -4, 3]);
    near(ecefToBuildingLocal(anchor, ecef), original);
    expect(original).toEqual([4, 10, 3]);
  });

  it("preserves precision at high latitudes, antimeridian and negative altitudes", () => {
    for (const anchor of [
      { ...malmo, latitudeDegrees: 89.9, longitudeDegrees: -179.99 },
      { ...malmo, latitudeDegrees: -78, longitudeDegrees: 180, ellipsoidalHeightMetres: -20 },
    ]) {
      const local = [12.345, -3.567, 2.5] as const;
      near(ecefToBuildingLocal(anchor, buildingLocalToEcef(anchor, local)), local);
    }
  });

  it("rejects invalid coordinates, missing altitude datum assumptions and nonfinite offsets", () => {
    for (const invalid of [
      { ...malmo, latitudeDegrees: 91 },
      { ...malmo, longitudeDegrees: 181 },
      { ...malmo, ellipsoidalHeightMetres: Infinity },
      { ...malmo, clockwiseYawRadians: NaN },
    ]) expect(() => assertGeodeticAnchor(invalid)).toThrow();
    expect(() => buildingLocalToEcef(malmo, [1, NaN, 3])).toThrow(/finite/);
    expect(() => ecefToEnu(malmo, [Infinity, 0, 0])).toThrow(/finite/);
  });
});
