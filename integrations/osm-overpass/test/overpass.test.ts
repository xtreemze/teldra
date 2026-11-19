import { describe, expect, it, vi } from "vitest";
import fixture from "../../../fixtures/osm/overpass-buildings-bbox.json";
import {
  OVERPASS_ATTRIBUTION,
  OverpassBuildingSource,
  OverpassError,
  buildOverpassQuery,
  parseOverpassBuildings,
} from "../src/index.js";

const bbox = { south: 55.6127, west: 12.9745, north: 55.6134, east: 12.9793 };
const retrievedAt = "2026-11-19T14:26:00Z";

function response(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: init.status ?? 200, headers: init.headers ?? {} });
}

describe("parseOverpassBuildings", () => {
  const result = parseOverpassBuildings(fixture, { retrievedAt });

  it("returns one provider-independent candidate per building with OSM identity", () => {
    expect(result.candidates).toHaveLength(15);
    const ids = result.candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(15);
    expect(ids).toContain("osm:way/30926877");
    expect(ids).toContain("osm:relation/13883429");
    for (const c of result.candidates) {
      expect(c.provider).toBe("osm-overpass");
      expect(c.dataset).toBe("OpenStreetMap");
      expect(c.retrievedAt).toBe(retrievedAt);
      expect(c.license).toBe("ODbL-1.0");
      expect(c.attribution).toBe(OVERPASS_ATTRIBUTION);
      expect(c.outer.length).toBeGreaterThanOrEqual(3);
      // Open ring: closing vertex is not repeated.
      expect(c.outer[0]).not.toEqual(c.outer[c.outer.length - 1]);
    }
  });

  it("keeps centroids inside the queried bounding box", () => {
    for (const c of result.candidates) {
      expect(c.centroid.latitudeDegrees).toBeGreaterThan(bbox.south - 0.001);
      expect(c.centroid.latitudeDegrees).toBeLessThan(bbox.north + 0.001);
      expect(c.centroid.longitudeDegrees).toBeGreaterThan(bbox.west - 0.001);
      expect(c.centroid.longitudeDegrees).toBeLessThan(bbox.east + 0.001);
    }
  });

  it("extracts building levels and type tags", () => {
    const tower = result.candidates.find((c) => c.id === "osm:way/30926877")!;
    expect(tower.levels).toBe(54);
    expect(tower.buildingType).toBe("apartments");
    expect(result.candidates.find((c) => c.id === "osm:way/89214388")!.levels).toBe(5);
    expect(result.candidates.find((c) => c.id === "osm:way/147530607")!.levels).toBeUndefined();
  });

  it("assembles multipolygon relation outers made of several member ways into one ring", () => {
    const relation = result.candidates.find((c) => c.id === "osm:relation/13883429")!;
    expect(relation.outer.length).toBeGreaterThanOrEqual(4);
  });

  it("carries the ODbL attribution and never exposes address or name tags", () => {
    expect(result.attribution).toContain("OpenStreetMap");
    expect(result.attribution).toContain("ODbL");
    expect(JSON.stringify(result.candidates)).not.toMatch(/addr|housenumber|\bstreet\b/i);
  });

  it("parses height tags with and without units and ignores unusable values", () => {
    const way = (id: number, tags: Record<string, string>) => ({
      type: "way", id, tags: { building: "yes", ...tags },
      geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.0001 }, { lat: 0.0001, lon: 0.0001 }, { lat: 0, lon: 0 }],
    });
    const parsed = parseOverpassBuildings({ elements: [way(1, { height: "12.5 m" }), way(2, { height: "9" }), way(3, { height: "tall" }), way(4, { "building:levels": "x" })] }, { retrievedAt });
    expect(parsed.candidates.map((c) => c.heightMetres)).toEqual([12.5, 9, undefined, undefined]);
    expect(parsed.candidates[3]!.levels).toBeUndefined();
  });

  it("skips unclosable or degenerate geometry and rejects non-Overpass payloads", () => {
    const parsed = parseOverpassBuildings({ elements: [{ type: "way", id: 9, tags: { building: "yes" }, geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] }] }, { retrievedAt });
    expect(parsed.candidates).toEqual([]);
    expect(() => parseOverpassBuildings({ nope: true }, { retrievedAt })).toThrow(OverpassError);
    expect(() => parseOverpassBuildings({ elements: [], remark: "runtime error: Query timed out" }, { retrievedAt })).toThrow(/timed out/);
  });
});

describe("buildOverpassQuery", () => {
  it("is a bounding-box-only query for building ways and relations", () => {
    const q = buildOverpassQuery(bbox, 25);
    expect(q).toContain("[out:json][timeout:25]");
    expect(q).toContain("(55.6127,12.9745,55.6134,12.9793)");
    expect(q).toContain('way["building"]');
    expect(q).toContain('relation["building"]');
    expect(q).toContain("out geom");
    expect(q).not.toMatch(/addr|name/);
  });

  it("rejects inverted, non-finite and oversized boxes", () => {
    expect(() => buildOverpassQuery({ ...bbox, south: 56 }, 25)).toThrow(/bounding box/i);
    expect(() => buildOverpassQuery({ ...bbox, west: Number.NaN }, 25)).toThrow(/bounding box/i);
    expect(() => buildOverpassQuery({ south: 55.6, west: 12.9, north: 55.7, east: 13.1 }, 25)).toThrow(/too large/i);
  });
});

describe("OverpassBuildingSource", () => {
  const make = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => {
    let now = 1_000_000;
    const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
    const source = new OverpassBuildingSource({ fetch: fetchImpl, now: clock.now, endpoint: "https://overpass.example/api/interpreter", ...extra });
    return { source, clock };
  };

  it("posts one bbox query with a generic User-Agent and parses the result", async () => {
    const fetchMock = vi.fn(async () => response(fixture));
    const { source } = make(fetchMock as unknown as typeof fetch);
    const result = await source.fetchBuildings(bbox);
    expect(result.candidates).toHaveLength(15);
    expect(result.fromCache).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://overpass.example/api/interpreter");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("User-Agent")).toMatch(/^teldra-site-placement\/\d/);
    expect(headers.get("User-Agent")).not.toMatch(/@|\/Users|carlos/i);
    expect(String(init.body)).toContain("data=");
    expect(decodeURIComponent(String(init.body))).toContain("(55.6127,12.9745,55.6134,12.9793)");
  });

  it("serves repeated identical requests from cache until the TTL expires", async () => {
    const fetchMock = vi.fn(async () => response(fixture));
    const { source, clock } = make(fetchMock as unknown as typeof fetch, { ttlMs: 60_000, minIntervalMs: 0 });
    await source.fetchBuildings(bbox);
    const second = await source.fetchBuildings({ ...bbox });
    expect(second.fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock.advance(61_000);
    const third = await source.fetchBuildings(bbox);
    expect(third.fromCache).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent identical requests", async () => {
    const fetchMock = vi.fn(async () => response(fixture));
    const { source } = make(fetchMock as unknown as typeof fetch);
    await Promise.all([source.fetchBuildings(bbox), source.fetchBuildings(bbox)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to hit the network again within the minimum interval", async () => {
    const fetchMock = vi.fn(async () => response(fixture));
    const { source, clock } = make(fetchMock as unknown as typeof fetch, { minIntervalMs: 10_000 });
    await source.fetchBuildings(bbox);
    const other = { ...bbox, east: bbox.east + 0.0001 };
    await expect(source.fetchBuildings(other)).rejects.toMatchObject({ kind: "throttled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock.advance(10_001);
    await expect(source.fetchBuildings(other)).resolves.toBeDefined();
  });

  it("classifies rate limiting and server busy responses without retrying", async () => {
    const limited = vi.fn(async () => response("slow down", { status: 429, headers: { "Retry-After": "30" } }));
    const a = make(limited as unknown as typeof fetch);
    await expect(a.source.fetchBuildings(bbox)).rejects.toMatchObject({ kind: "rate-limited", retryAfterMs: 30_000 });
    expect(limited).toHaveBeenCalledTimes(1);

    const busy = vi.fn(async () => response("# 504 Gateway Timeout", { status: 504 }));
    const b = make(busy as unknown as typeof fetch);
    await expect(b.source.fetchBuildings(bbox)).rejects.toMatchObject({ kind: "busy" });
    expect(busy).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response("x", { status: 504 }))
      .mockResolvedValueOnce(response(fixture));
    const { source } = make(fetchMock as unknown as typeof fetch, { minIntervalMs: 0 });
    await expect(source.fetchBuildings(bbox)).rejects.toBeInstanceOf(OverpassError);
    await expect(source.fetchBuildings(bbox)).resolves.toMatchObject({ fromCache: false });
  });
});
