import { describe, expect, it } from "vitest";
import {
  createLocalEnuFrame, osmWaysToEnvironmentTile, parseMetres, triangulateSimpleRing, wgs84ToEnu,
  type OsmGeomWay,
} from "../src/index.js";

// Synthetic fixture: invented geometry at an arbitrary public test origin (not any real project site).
const frame = createLocalEnuFrame({ latitudeDeg: 59.27, longitudeDeg: 15.21, heightM: 0 });
const DLAT = 0.00018; // ~20 m north
const DLON = 0.00035; // ~20 m east at this latitude
const pt = (e: number, n: number) => ({ lat: 59.27 + n * DLAT, lon: 15.21 + e * DLON });
const ring = (...c: [number, number][]) => [...c, c[0]!].map(([e, n]) => pt(e, n));

const SQUARE_CW: OsmGeomWay = {
  type: "way", id: 20, tags: { building: "yes", height: "12 m" },
  geometry: ring([0, 0], [0, 1], [1, 1], [1, 0]), // clockwise on purpose
};
const LEVELS: OsmGeomWay = {
  type: "way", id: 10, tags: { building: "house", "building:levels": "3" },
  geometry: ring([2, 0], [3, 0], [3, 1], [2, 1]),
};
const BARE: OsmGeomWay = {
  type: "way", id: 30, tags: { building: "yes" }, geometry: ring([4, 0], [5, 0], [5, 1], [4, 1]),
};
const L_SHAPE: OsmGeomWay = {
  type: "way", id: 40, tags: { building: "yes", height: "5" },
  geometry: ring([6, 0], [8, 0], [8, 1], [7, 1], [7, 2], [6, 2]),
};
const ROAD: OsmGeomWay = {
  type: "way", id: 50, tags: { highway: "residential", width: "6" },
  geometry: [pt(0, -1), pt(3, -1)],
};
const PATH: OsmGeomWay = {
  type: "way", id: 60, tags: { highway: "footway" }, geometry: [pt(0, -2), pt(3, -2)],
};
const OPEN: OsmGeomWay = {
  type: "way", id: 70, tags: { building: "yes" }, geometry: [pt(0, 5), pt(1, 5), pt(1, 6)],
};

const opts = { tileId: "env:test/0/0", frame };
const tile = osmWaysToEnvironmentTile([SQUARE_CW, LEVELS, BARE, L_SHAPE, ROAD, PATH, OPEN], opts);
const mesh = (id: string) => tile.meshes.find((m) => m.envId === `env:osm:way/${id}`)!;
const zs = (m: { positions: Float32Array }) =>
  Array.from({ length: m.positions.length / 3 }, (_, i) => m.positions[i * 3 + 2]!);

describe("wgs84ToEnu", () => {
  it("maps the origin to zero and uses east/north/up axes in metres", () => {
    const o = wgs84ToEnu(frame, 59.27, 15.21, 0);
    o.forEach((v) => expect(Math.abs(v)).toBeLessThan(1e-6));
    const [e, n, u] = wgs84ToEnu(frame, 59.27 + 0.001, 15.21);
    expect(n).toBeCloseTo(111.4, 0); // 0.001 deg latitude is about 111 m at 59 N
    expect(Math.abs(e)).toBeLessThan(0.05);
    expect(u).toBeLessThan(0); // the tangent plane rises above the curved surface
    const [e2] = wgs84ToEnu(frame, 59.27, 15.21 + 0.001);
    expect(e2).toBeCloseTo(111.32 * Math.cos((59.27 * Math.PI) / 180), 0);
  });
});

describe("parseMetres", () => {
  it("accepts metres, rejects other units and non-positive values", () => {
    expect(parseMetres("12")).toBe(12);
    expect(parseMetres("12,5 m")).toBe(12.5);
    expect(parseMetres("40 ft")).toBeUndefined();
    expect(parseMetres("0")).toBeUndefined();
    expect(parseMetres(undefined)).toBeUndefined();
  });
});

describe("osmWaysToEnvironmentTile: buildings", () => {
  it("extrudes the footprint to tag:height, flagged reconstructed, and casts shadows", () => {
    const m = mesh("20");
    expect(m.kind).toBe("building");
    expect(Math.max(...zs(m))).toBeCloseTo(12, 5);
    expect(Math.min(...zs(m))).toBeCloseTo(0, 5);
    expect(m.provenance).toEqual({ geometryClass: "reconstructed", heightBasis: "tag:height" });
    expect(m.castsShadow).toBe(true);
    expect(m.drapeOnTerrain).toBe(false);
  });
  it("falls back to levels x metres-per-level, then to an estimated default", () => {
    expect(Math.max(...zs(mesh("10")))).toBeCloseTo(9, 5);
    expect(mesh("10").provenance.heightBasis).toBe("tag:building:levels");
    expect(Math.max(...zs(mesh("30")))).toBeCloseTo(6, 5);
    expect(mesh("30").provenance).toEqual({ geometryClass: "estimated", heightBasis: "default" });
  });
  it("normalises clockwise footprints so roof normals face up", () => {
    const m = mesh("20");
    let roofUp = 0;
    for (let i = 0; i < m.indices.length; i += 3) {
      const v = [0, 1, 2].map((k) => m.indices[i + k]! * 3);
      const [a, b, c] = v as [number, number, number];
      const P = m.positions;
      if (Math.abs(P[a + 2]! - 12) < 1e-4 && Math.abs(P[b + 2]! - 12) < 1e-4 && Math.abs(P[c + 2]! - 12) < 1e-4) {
        const nz = (P[b]! - P[a]!) * (P[c + 1]! - P[a + 1]!) - (P[b + 1]! - P[a + 1]!) * (P[c]! - P[a]!);
        expect(nz).toBeGreaterThan(0);
        roofUp++;
      }
    }
    expect(roofUp).toBe(2);
  });
  it("triangulates concave footprints with area preserved", () => {
    const r = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]] as const;
    const t = triangulateSimpleRing(r)!;
    let area = 0;
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [r[t[i]!]!, r[t[i + 1]!]!, r[t[i + 2]!]!];
      area += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    }
    expect(area).toBeCloseTo(3, 9);
    // 4 roof + 4 floor + 12 wall triangles
    expect(mesh("40").indices.length).toBe(20 * 3);
  });
  it("reports unsupported input as diagnostics instead of dropping it silently", () => {
    expect(tile.meshes.find((m) => m.source.externalId === "way/70")).toBeUndefined();
    expect(tile.diagnostics).toEqual([expect.objectContaining({ externalId: "way/70", code: "open-ring" })]);
  });
});

describe("osmWaysToEnvironmentTile: roads and paths", () => {
  it("builds a ribbon of the tagged width, draped, not shadow-casting", () => {
    const m = mesh("50");
    expect(m.kind).toBe("road");
    expect(m.provenance).toEqual({ geometryClass: "reconstructed", widthBasis: "tag:width" });
    expect(m.drapeOnTerrain).toBe(true);
    expect(m.castsShadow).toBe(false);
    const ns = Array.from({ length: 4 }, (_, i) => m.positions[i * 3 + 1]!);
    expect(Math.max(...ns) - Math.min(...ns)).toBeCloseTo(6, 3);
    expect(m.indices.length).toBe(6);
  });
  it("classifies footways as paths with an estimated class-default width", () => {
    expect(mesh("60").kind).toBe("path");
    expect(mesh("60").provenance).toEqual({ geometryClass: "estimated", widthBasis: "default" });
  });
});

describe("osmWaysToEnvironmentTile: contract", () => {
  it("is deterministic and independent of input order", () => {
    const again = osmWaysToEnvironmentTile([OPEN, PATH, ROAD, L_SHAPE, BARE, LEVELS, SQUARE_CW], opts);
    expect(again.meshes.map((m) => m.envId)).toEqual(tile.meshes.map((m) => m.envId));
    expect(Array.from(again.meshes[0]!.positions)).toEqual(Array.from(tile.meshes[0]!.positions));
  });
  it("keeps environment ids out of the canonical/IFC identity space and records source and attribution", () => {
    for (const m of tile.meshes) {
      expect(m.envId).toMatch(/^env:osm:way\/\d+$/);
      expect(m.source).toEqual({ provider: "osm", externalId: m.envId.replace("env:osm:", "") });
      expect(m).not.toHaveProperty("ifcGlobalId");
      expect(m).not.toHaveProperty("canonicalId");
    }
    expect(tile.source.licence).toBe("ODbL-1.0");
    expect(tile.source.attribution).toContain("OpenStreetMap");
    expect(tile.frame.axes).toBe("east-north-up");
  });
  it("computes ENU bounds covering all meshes", () => {
    expect(tile.bounds.max[2]).toBeCloseTo(12, 5);
    expect(tile.bounds.min[1]).toBeLessThan(-30); // footway ribbon sits ~40 m south of origin
  });
});
