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

  describe("Malmo, Sweden site (~55.6N, 13.0E)", () => {
    const site: GeodeticAnchor = {
      latitudeDegrees: 55.6, longitudeDegrees: 13.0,
      ellipsoidalHeightMetres: 0, clockwiseYawRadians: 0,
    };
    const DEG = Math.PI / 180;
    // WGS84 radii of curvature at the site latitude, computed independently.
    const e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
    const s2 = Math.sin(site.latitudeDegrees * DEG) ** 2;
    const prime = 6378137 / Math.sqrt(1 - e2 * s2);
    const meridian = (6378137 * (1 - e2)) / (1 - e2 * s2) ** 1.5;

    it("maps a geodetic neighbour to ENU metres matching local radii of curvature", () => {
      const dLat = 0.001, dLon = 0.001;
      const neighbour = geodeticToEcef(site.latitudeDegrees + dLat, site.longitudeDegrees + dLon, 0);
      const [east, north, up] = ecefToEnu(site, neighbour);
      const expectedEast = prime * Math.cos(site.latitudeDegrees * DEG) * dLon * DEG;
      const expectedNorth = meridian * dLat * DEG;
      expect(east).toBeGreaterThan(60);
      expect(east).toBeLessThan(66);
      expect(Math.abs(east - expectedEast)).toBeLessThan(0.01);
      expect(Math.abs(north - expectedNorth)).toBeLessThan(0.01);
      // The ellipsoid curves away from the tangent plane: tiny negative Up.
      expect(up).toBeLessThan(0);
      expect(up).toBeGreaterThan(-0.01);
    });

    it("keeps Up aligned with the ellipsoid normal: +10 m height equals a 10 m shift", () => {
      const base = geodeticToEcef(site.latitudeDegrees, site.longitudeDegrees, 0);
      const raised = enuToEcef(site, [0, 0, 10]);
      expect(Math.hypot(raised[0] - base[0], raised[1] - base[1], raised[2] - base[2])).toBeCloseTo(10, 9);
      near(raised, geodeticToEcef(site.latitudeDegrees, site.longitudeDegrees, 10), 1e-6);
    });

    it("rotates local axes clockwise by yaw with exact lengths", () => {
      const yaw = 30 * DEG;
      const anchor = { ...site, clockwiseYawRadians: yaw };
      const [east, north] = ecefToEnu(anchor, buildingLocalToEcef(anchor, [20, 10, 0]));
      expect(Math.abs(Math.hypot(east, north) - Math.hypot(20, 10))).toBeLessThan(1e-6);
      const [ex, ey] = ecefToEnu(anchor, buildingLocalToEcef(anchor, [1, 0, 0]));
      expect(Math.abs(ex - Math.cos(yaw))).toBeLessThan(1e-6);
      expect(Math.abs(ey + Math.sin(yaw))).toBeLessThan(1e-6);
      const [nx, ny] = ecefToEnu(anchor, buildingLocalToEcef(anchor, [0, 1, 0]));
      expect(Math.abs(nx - Math.sin(yaw))).toBeLessThan(1e-6);
      expect(Math.abs(ny - Math.cos(yaw))).toBeLessThan(1e-6);
    });

    it("treats yaw modulo a full turn identically and roundtrips arbitrary yaws", () => {
      const local = [37.25, -14.5, 6.75] as const;
      const a = buildingLocalToEcef({ ...site, clockwiseYawRadians: 0.7 }, local);
      near(a, buildingLocalToEcef({ ...site, clockwiseYawRadians: 0.7 + 2 * Math.PI }, local), 1e-6);
      near(a, buildingLocalToEcef({ ...site, clockwiseYawRadians: 0.7 - 4 * Math.PI }, local), 1e-6);
      for (const yaw of [-Math.PI, -1.2, 0, 2.5, Math.PI, 7]) {
        const anchor = { ...site, clockwiseYawRadians: yaw };
        near(ecefToBuildingLocal(anchor, buildingLocalToEcef(anchor, local)), local, 1e-6);
      }
    });

    it("keeps micrometre-scale roundtrip precision for a ~1.5 km offset despite 6.4e6 m ECEF magnitudes", () => {
      const anchor = { ...site, clockwiseYawRadians: 0.3 };
      const local = [1234.567891, -987.654321, 15.123456] as const;
      near(ecefToBuildingLocal(anchor, buildingLocalToEcef(anchor, local)), local, 1e-6);
    });

    it("does not mutate frozen anchors or input points", () => {
      const anchor = Object.freeze({ ...site, clockwiseYawRadians: 1 });
      const point = Object.freeze([1, 2, 3] as const);
      buildingLocalToEcef(anchor, point);
      expect(point).toEqual([1, 2, 3]);
    });
  });
});
