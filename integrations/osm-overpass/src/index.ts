import type { BoundingBox, BuildingFootprintCandidate, GeoPoint } from "@teldra/application";

/**
 * OpenStreetMap Overpass adapter: candidate building footprints for a bounding
 * box. Output is environmental geography evidence, never IFC geometry. OSM data
 * is ODbL 1.0; the attribution below must be shown wherever candidates appear.
 */
export const OVERPASS_ATTRIBUTION = "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)";
export const OVERPASS_DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";
export const OVERPASS_USER_AGENT = "teldra-site-placement/0.1";
/** Usage policy guard rails: small boxes only, no hammering. */
export const OVERPASS_MAX_AREA_SQUARE_KM = 1;

export type OverpassErrorKind = "invalid" | "throttled" | "rate-limited" | "busy" | "http" | "network" | "query";

export class OverpassError extends Error {
  readonly kind: OverpassErrorKind;
  readonly retryAfterMs?: number;
  constructor(kind: OverpassErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "OverpassError";
    this.kind = kind;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

function assertBoundingBox(bbox: BoundingBox): void {
  const values = [bbox.south, bbox.west, bbox.north, bbox.east];
  if (!values.every(Number.isFinite) || bbox.south >= bbox.north || bbox.west >= bbox.east ||
      Math.abs(bbox.south) > 90 || Math.abs(bbox.north) > 90 || Math.abs(bbox.west) > 180 || Math.abs(bbox.east) > 180)
    throw new OverpassError("invalid", "Invalid bounding box: expected finite south < north and west < east within WGS84 bounds.");
  const midLat = ((bbox.south + bbox.north) / 2) * (Math.PI / 180);
  const km2 = (bbox.north - bbox.south) * 111.32 * (bbox.east - bbox.west) * 111.32 * Math.cos(midLat);
  if (km2 > OVERPASS_MAX_AREA_SQUARE_KM)
    throw new OverpassError("invalid", `Bounding box is too large for the public Overpass service (max ${OVERPASS_MAX_AREA_SQUARE_KM} km²).`);
}

export function buildOverpassQuery(bbox: BoundingBox, timeoutSeconds = 25): string {
  assertBoundingBox(bbox);
  const b = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  return `[out:json][timeout:${timeoutSeconds}];(way["building"]${b};relation["building"]${b};);out geom;`;
}

interface RawPoint { lat: number; lon: number }
interface RawMember { type?: string; role?: string; geometry?: RawPoint[] }
interface RawElement { type?: string; id?: number; tags?: Record<string, string>; geometry?: RawPoint[]; members?: RawMember[] }

export interface ParsedOverpassBuildings {
  readonly candidates: readonly BuildingFootprintCandidate[];
  readonly attribution: string;
  /** Overpass data timestamp when the response carried one. */
  readonly dataTimestamp?: string;
}

const same = (a: GeoPoint, b: GeoPoint) => a.latitudeDegrees === b.latitudeDegrees && a.longitudeDegrees === b.longitudeDegrees;
const toPoint = (p: RawPoint): GeoPoint => ({ latitudeDegrees: p.lat, longitudeDegrees: p.lon });

function openRing(points: readonly GeoPoint[]): GeoPoint[] | undefined {
  const ring = [...points];
  if (ring.length > 1 && same(ring[0]!, ring[ring.length - 1]!)) ring.pop();
  return ring.length >= 3 ? ring : undefined;
}

/** Join open member ways end to end into closed rings. */
function assembleRings(segments: readonly GeoPoint[][]): GeoPoint[][] {
  const pool = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  const rings: GeoPoint[][] = [];
  while (pool.length > 0) {
    let chain = pool.shift()!;
    let grew = true;
    while (grew && !same(chain[0]!, chain[chain.length - 1]!)) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i]!;
        const head = chain[0]!, tail = chain[chain.length - 1]!;
        if (same(tail, s[0]!)) chain = [...chain, ...s.slice(1)];
        else if (same(tail, s[s.length - 1]!)) chain = [...chain, ...[...s].reverse().slice(1)];
        else if (same(head, s[s.length - 1]!)) chain = [...s, ...chain.slice(1)];
        else if (same(head, s[0]!)) chain = [...[...s].reverse(), ...chain.slice(1)];
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (same(chain[0]!, chain[chain.length - 1]!)) {
      const ring = openRing(chain);
      if (ring) rings.push(ring);
    }
  }
  return rings;
}

function planarArea(ring: readonly GeoPoint[]): number {
  const lat0 = ring.reduce((s, p) => s + p.latitudeDegrees, 0) / ring.length;
  const k = Math.cos(lat0 * (Math.PI / 180));
  let a = 0;
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    a += p.longitudeDegrees * k * q.latitudeDegrees - q.longitudeDegrees * k * p.latitudeDegrees;
  });
  return a / 2;
}

function centroid(ring: readonly GeoPoint[]): GeoPoint {
  const a = planarArea(ring);
  if (Math.abs(a) < 1e-18)
    return { latitudeDegrees: ring.reduce((s, p) => s + p.latitudeDegrees, 0) / ring.length, longitudeDegrees: ring.reduce((s, p) => s + p.longitudeDegrees, 0) / ring.length };
  const lat0 = ring.reduce((s, p) => s + p.latitudeDegrees, 0) / ring.length;
  const k = Math.cos(lat0 * (Math.PI / 180));
  let cx = 0, cy = 0;
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    const x1 = p.longitudeDegrees * k, y1 = p.latitudeDegrees, x2 = q.longitudeDegrees * k, y2 = q.latitudeDegrees;
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  });
  return { latitudeDegrees: cy / (6 * a), longitudeDegrees: cx / (6 * a) / k };
}

function parseLevels(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*\d+\s*$/.test(value)) return undefined;
  return Number.parseInt(value, 10);
}

function parseHeight(value: string | undefined): number | undefined {
  const m = value === undefined ? null : /^\s*(\d+(?:\.\d+)?)\s*(?:m)?\s*$/.exec(value);
  return m ? Number.parseFloat(m[1]!) : undefined;
}

export function parseOverpassBuildings(payload: unknown, context: { retrievedAt: string }): ParsedOverpassBuildings {
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { elements?: unknown }).elements))
    throw new OverpassError("invalid", "Response is not an Overpass JSON document.");
  const doc = payload as { elements: RawElement[]; remark?: string; osm3s?: { timestamp_osm_base?: string } };
  if (typeof doc.remark === "string" && /error|timed out/i.test(doc.remark))
    throw new OverpassError("query", `Overpass reported: ${doc.remark}`);

  const candidates: BuildingFootprintCandidate[] = [];
  for (const el of doc.elements) {
    if ((el.type !== "way" && el.type !== "relation") || typeof el.id !== "number") continue;
    let outer: GeoPoint[] | undefined;
    let holes: GeoPoint[][] = [];
    if (el.type === "way") {
      outer = openRing((el.geometry ?? []).map(toPoint));
    } else {
      const members = el.members ?? [];
      const geomOf = (role: (r: string | undefined) => boolean) =>
        members.filter((m) => m.type === "way" && role(m.role) && m.geometry).map((m) => m.geometry!.map(toPoint));
      const outers = assembleRings(geomOf((r) => r === "outer" || r === "" || r === undefined));
      outer = outers.sort((x, y) => Math.abs(planarArea(y)) - Math.abs(planarArea(x)))[0];
      holes = assembleRings(geomOf((r) => r === "inner"));
    }
    if (!outer) continue;
    const tags = el.tags ?? {};
    const levels = parseLevels(tags["building:levels"]);
    const heightMetres = parseHeight(tags.height);
    const candidate: BuildingFootprintCandidate = {
      id: `osm:${el.type}/${el.id}`,
      provider: "osm-overpass",
      dataset: "OpenStreetMap",
      outer,
      ...(holes.length > 0 ? { holes } : {}),
      centroid: centroid(outer),
      ...(levels !== undefined ? { levels } : {}),
      ...(heightMetres !== undefined ? { heightMetres } : {}),
      ...(typeof tags.building === "string" ? { buildingType: tags.building } : {}),
      attribution: OVERPASS_ATTRIBUTION,
      license: "ODbL-1.0",
      retrievedAt: context.retrievedAt,
    };
    candidates.push(candidate);
  }
  const ts = doc.osm3s?.timestamp_osm_base;
  return { candidates, attribution: OVERPASS_ATTRIBUTION, ...(ts ? { dataTimestamp: ts } : {}) };
}

export interface OverpassCacheEntry { readonly storedAtMs: number; readonly value: OverpassBuildingsResult }
export interface OverpassCache {
  get(key: string): OverpassCacheEntry | undefined;
  set(key: string, entry: OverpassCacheEntry): void;
}

export interface OverpassBuildingsResult extends ParsedOverpassBuildings {
  readonly fromCache: boolean;
}

export interface OverpassBuildingSourceOptions {
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly cache?: OverpassCache;
  /** Cache lifetime; building footprints change slowly. Default 24 h. */
  readonly ttlMs?: number;
  /** Minimum gap between network requests from this source. Default 10 s. */
  readonly minIntervalMs?: number;
  readonly timeoutSeconds?: number;
}

export class OverpassBuildingSource {
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cache: OverpassCache;
  readonly #ttl: number;
  readonly #minInterval: number;
  readonly #timeout: number;
  readonly #inflight = new Map<string, Promise<OverpassBuildingsResult>>();
  #lastNetworkAt = Number.NEGATIVE_INFINITY;

  constructor(options: OverpassBuildingSourceOptions = {}) {
    this.#endpoint = options.endpoint ?? OVERPASS_DEFAULT_ENDPOINT;
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.#now = options.now ?? Date.now;
    const map = new Map<string, OverpassCacheEntry>();
    this.#cache = options.cache ?? { get: (k) => map.get(k), set: (k, v) => void map.set(k, v) };
    this.#ttl = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.#minInterval = options.minIntervalMs ?? 10_000;
    this.#timeout = options.timeoutSeconds ?? 25;
  }

  fetchBuildings(bbox: BoundingBox, signal?: AbortSignal): Promise<OverpassBuildingsResult> {
    const query = buildOverpassQuery(bbox, this.#timeout); // validates the box
    const key = [bbox.south, bbox.west, bbox.north, bbox.east].map((v) => v.toFixed(5)).join(",");
    const cached = this.#cache.get(key);
    if (cached && this.#now() - cached.storedAtMs < this.#ttl) return Promise.resolve({ ...cached.value, fromCache: true });
    const pending = this.#inflight.get(key);
    if (pending) return pending;
    const wait = this.#lastNetworkAt + this.#minInterval - this.#now();
    if (wait > 0) return Promise.reject(new OverpassError("throttled", `Overpass requests are limited; retry in ${Math.ceil(wait / 1000)} s.`, wait));
    this.#lastNetworkAt = this.#now();
    const run = this.#request(key, query, signal).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, run);
    return run;
  }

  async #request(key: string, query: string, signal?: AbortSignal): Promise<OverpassBuildingsResult> {
    let res: Response;
    try {
      res = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": OVERPASS_USER_AGENT },
        body: `data=${encodeURIComponent(query)}`,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new OverpassError("network", `Overpass request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status === 429) {
      const seconds = Number(res.headers.get("Retry-After"));
      throw new OverpassError("rate-limited", "Overpass rate limit reached.", Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
    }
    if (res.status === 502 || res.status === 503 || res.status === 504)
      throw new OverpassError("busy", `Overpass service is busy (HTTP ${res.status}); try again later.`);
    if (!res.ok) throw new OverpassError("http", `Overpass returned HTTP ${res.status}.`);
    let json: unknown;
    try { json = await res.json(); } catch { throw new OverpassError("invalid", "Overpass response was not valid JSON."); }
    const parsed = parseOverpassBuildings(json, { retrievedAt: new Date(this.#now()).toISOString().replace(/\.\d{3}Z$/, "Z") });
    const value: OverpassBuildingsResult = { ...parsed, fromCache: false };
    this.#cache.set(key, { storedAtMs: this.#now(), value });
    return value;
  }
}
