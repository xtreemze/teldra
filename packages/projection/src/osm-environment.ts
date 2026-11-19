import {
  type EnvironmentDiagnostic,
  type EnvironmentMesh,
  type EnvironmentTile,
  type LocalEnuFrame,
  wgs84ToEnu,
} from "./environment-tile.js";

/** Minimal shape of an Overpass `out geom;` way. Renderer- and network-independent. */
export interface OsmGeomWay {
  readonly type: "way";
  readonly id: number;
  readonly tags?: Readonly<Record<string, string>>;
  readonly geometry: readonly { readonly lat: number; readonly lon: number }[];
}

export interface OsmEnvironmentOptions {
  readonly tileId: string;
  readonly frame: LocalEnuFrame;
  readonly lod?: number;
  readonly retrievedAt?: string;
  /** Metres per level when only `building:levels` is known. */
  readonly metresPerLevel?: number;
  /** Used when neither `height` nor `building:levels` exists; flagged `estimated`. */
  readonly defaultBuildingHeightM?: number;
  readonly defaultRoadWidthM?: number;
}

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
export const OSM_LICENCE = "ODbL-1.0";

const DEFAULT_ROAD_WIDTH_M: Readonly<Record<string, number>> = {
  motorway: 12, trunk: 10, primary: 8, secondary: 7, tertiary: 6,
  residential: 5, service: 3.5, living_street: 4.5, unclassified: 5,
  footway: 2, pedestrian: 4, cycleway: 2.5, path: 1.5, steps: 1.5,
};
const PATH_CLASSES = new Set(["footway", "cycleway", "path", "steps", "pedestrian"]);
const LANE_WIDTH_M = 3;

/** Parses "12", "12.5", "12 m". Rejects negatives, zero, and unit-bearing non-metre values. */
export function parseMetres(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(m)?\s*$/.exec(value);
  if (m?.[1] === undefined) return undefined;
  const n = Number(m[1].replace(",", "."));
  return n > 0 ? n : undefined;
}

type Pt = readonly [number, number];

function signedArea(ring: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function inTriangle(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
}

/** Ear clipping of a simple CCW ring (no holes). Returns ring-index triples, or undefined if degenerate. */
export function triangulateSimpleRing(ring: readonly Pt[]): number[] | undefined {
  const idx = ring.map((_, i) => i);
  const out: number[] = [];
  let guard = ring.length * ring.length;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length]!;
      const ib = idx[k]!;
      const ic = idx[(k + 1) % idx.length]!;
      const a = ring[ia]!, b = ring[ib]!, c = ring[ic]!;
      if (cross(a, b, c) <= 1e-9) continue; // reflex or collinear
      const blocked = idx.some(
        (j) => j !== ia && j !== ib && j !== ic && inTriangle(ring[j]!, a, b, c),
      );
      if (blocked) continue;
      out.push(ia, ib, ic);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) return undefined;
  }
  if (idx.length === 3) out.push(idx[0]!, idx[1]!, idx[2]!);
  return out;
}

function extrudeBuilding(ring: readonly Pt[], baseZ: number, topZ: number): { positions: number[]; indices: number[] } | undefined {
  const tris = triangulateSimpleRing(ring);
  if (tris === undefined) return undefined;
  const n = ring.length;
  const positions: number[] = [];
  const indices: number[] = [];
  // bottom ring [0..n), top ring [n..2n)
  for (const p of ring) positions.push(p[0], p[1], baseZ);
  for (const p of ring) positions.push(p[0], p[1], topZ);
  // roof (CCW, normal +Z) and floor (reversed, normal -Z)
  for (let i = 0; i < tris.length; i += 3) {
    indices.push(n + tris[i]!, n + tris[i + 1]!, n + tris[i + 2]!);
    indices.push(tris[i]!, tris[i + 2]!, tris[i + 1]!);
  }
  // walls, outward-facing for a CCW footprint
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, n + j, i, n + j, n + i);
  }
  return { positions, indices };
}

function ribbon(line: readonly Pt[], width: number, z: number): { positions: number[]; indices: number[] } | undefined {
  if (line.length < 2) return undefined;
  const half = width / 2;
  const positions: number[] = [];
  const indices: number[] = [];
  const normalAt = (i: number): Pt => {
    const prev = line[Math.max(0, i - 1)]!;
    const next = line[Math.min(line.length - 1, i + 1)]!;
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy);
    return len === 0 ? [0, 0] : [-dy / len, dx / len];
  };
  for (let i = 0; i < line.length; i++) {
    const p = line[i]!;
    const nrm = normalAt(i);
    positions.push(p[0] + nrm[0] * half, p[1] + nrm[1] * half, z);
    positions.push(p[0] - nrm[0] * half, p[1] - nrm[1] * half, z);
  }
  for (let i = 0; i < line.length - 1; i++) {
    const l0 = i * 2, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3;
    // direction x left-normal => left vertex is CCW-first, so +Z faces up
    indices.push(r0, r1, l0, l0, r1, l1);
  }
  return { positions, indices };
}

function bounds(meshes: readonly EnvironmentMesh[]): EnvironmentTile["bounds"] {
  const min = [Infinity, Infinity, Infinity] as [number, number, number];
  const max = [-Infinity, -Infinity, -Infinity] as [number, number, number];
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = m.positions[i + a]!;
        if (v < min[a]!) min[a] = v;
        if (v > max[a]!) max[a] = v;
      }
    }
  }
  return meshes.length === 0 ? { min: [0, 0, 0], max: [0, 0, 0] } : { min, max };
}

/**
 * Converts OSM buildings and roads/paths into procedural environment meshes in the tile's ENU frame.
 * Pure and deterministic: same input, same output order (sorted by way id).
 *
 * Provenance: footprint + `height`/`building:levels` => "reconstructed"; default height => "estimated".
 * Roads: explicit `width`/`lanes` => "reconstructed", otherwise class default => "estimated".
 * Unsupported input (open building rings, self-intersections, multipolygon holes) is reported in
 * `diagnostics`, never silently dropped or "repaired".
 */
export function osmWaysToEnvironmentTile(
  ways: readonly OsmGeomWay[],
  options: OsmEnvironmentOptions,
): EnvironmentTile {
  const mpl = options.metresPerLevel ?? 3;
  const defH = options.defaultBuildingHeightM ?? 6;
  const meshes: EnvironmentMesh[] = [];
  const diagnostics: EnvironmentDiagnostic[] = [];
  const toEnu = (g: OsmGeomWay["geometry"]): Pt[] =>
    g.map((p) => {
      const e = wgs84ToEnu(options.frame, p.lat, p.lon);
      return [e[0], e[1]] as const;
    });

  for (const way of [...ways].sort((a, b) => a.id - b.id)) {
    const tags = way.tags ?? {};
    const externalId = `way/${way.id}`;
    const envId = `env:osm:${externalId}`;
    const source = { provider: "osm", externalId } as const;

    if (tags["building"] !== undefined && tags["building"] !== "no") {
      let pts = toEnu(way.geometry);
      const closed = pts.length > 3 && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1];
      if (!closed) {
        diagnostics.push({ externalId, code: "open-ring", message: "building way is not a closed ring" });
        continue;
      }
      pts = pts.slice(0, -1);
      if (signedArea(pts) < 0) pts = pts.reverse();
      if (Math.abs(signedArea(pts)) < 0.5) {
        diagnostics.push({ externalId, code: "degenerate-footprint", message: "footprint area below 0.5 m2" });
        continue;
      }
      const explicit = parseMetres(tags["height"]);
      const levels = parseMetres(tags["building:levels"]);
      const [h, basis, cls] =
        explicit !== undefined ? ([explicit, "tag:height", "reconstructed"] as const)
        : levels !== undefined ? ([levels * mpl, "tag:building:levels", "reconstructed"] as const)
        : ([defH, "default", "estimated"] as const);
      const baseZ = parseMetres(tags["min_height"]) ?? 0;
      if (h <= baseZ) {
        diagnostics.push({ externalId, code: "non-positive-extent", message: "height must exceed min_height" });
        continue;
      }
      const solid = extrudeBuilding(pts, baseZ, h);
      if (solid === undefined) {
        diagnostics.push({ externalId, code: "triangulation-failed", message: "footprint is not a simple polygon" });
        continue;
      }
      meshes.push({
        envId, kind: "building", source,
        positions: Float32Array.from(solid.positions), indices: Uint32Array.from(solid.indices),
        provenance: { geometryClass: cls, heightBasis: basis },
        castsShadow: true, drapeOnTerrain: false,
      });
      continue;
    }

    const hw = tags["highway"];
    if (hw !== undefined) {
      const explicit = parseMetres(tags["width"]);
      const lanes = parseMetres(tags["lanes"]);
      const [w, basis, cls] =
        explicit !== undefined ? ([explicit, "tag:width", "reconstructed"] as const)
        : lanes !== undefined ? ([lanes * LANE_WIDTH_M, "tag:lanes", "reconstructed"] as const)
        : ([DEFAULT_ROAD_WIDTH_M[hw] ?? options.defaultRoadWidthM ?? 5, "default", "estimated"] as const);
      const r = ribbon(toEnu(way.geometry), w, 0);
      if (r === undefined) {
        diagnostics.push({ externalId, code: "degenerate-line", message: "highway way has fewer than 2 nodes" });
        continue;
      }
      meshes.push({
        envId, kind: PATH_CLASSES.has(hw) ? "path" : "road", source,
        positions: Float32Array.from(r.positions), indices: Uint32Array.from(r.indices),
        provenance: { geometryClass: cls, widthBasis: basis },
        castsShadow: false, drapeOnTerrain: true,
      });
    }
  }

  return {
    schemaVersion: "0.1.0",
    tileId: options.tileId,
    frame: options.frame,
    source: {
      provider: "osm",
      licence: OSM_LICENCE,
      attribution: OSM_ATTRIBUTION,
      ...(options.retrievedAt === undefined ? {} : { retrievedAt: options.retrievedAt }),
    },
    lod: options.lod ?? 0,
    bounds: bounds(meshes),
    meshes,
    diagnostics,
  };
}
