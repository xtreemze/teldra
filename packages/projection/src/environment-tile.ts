/**
 * Provider-independent environment-context contract (ADR 0024, issue #129).
 *
 * Environment tiles are a DERIVED, non-canonical layer: surrounding terrain, neighbouring buildings,
 * roads and vegetation used for context and shadow casting. They never enter IFC or the twin format,
 * never carry IFC GlobalIds or Teldra canonical ids, and are regenerable from their source records.
 *
 * Coordinates: every mesh is expressed in a local ENU frame (East, North, Up), metres, right-handed,
 * Z-up, anchored at an explicit WGS84 origin. Converting to a renderer frame (glTF Y-up, Babylon
 * left-handed, deck.gl) is the adapter's job and must go through an explicit transform (ADR 0005).
 */

/** How trustworthy the geometry is. Drives UI badges and whether it may be used for shadow studies. */
export type EnvironmentGeometryClass =
  /** Surveyed/sensed geometry (lidar DTM/DSM, photogrammetry). */
  | "measured"
  /** Built from surveyed 2D data plus recorded attributes (footprint + tagged height/levels). */
  | "reconstructed"
  /** Built from footprints plus guessed attributes (default heights, default road widths). */
  | "estimated";

export type EnvironmentFeatureKind =
  | "building"
  | "road"
  | "path"
  | "terrain"
  | "vegetation"
  | "water";

export interface Wgs84Origin {
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  /** Ellipsoidal height in metres. */
  readonly heightM: number;
}

export interface LocalEnuFrame {
  readonly kind: "local-enu";
  readonly origin: Wgs84Origin;
  readonly axes: "east-north-up";
  readonly unit: "metre";
}

export interface EnvironmentSourceRecord {
  /** e.g. "osm", "overture", "lantmateriet-dtm". Free-form provider key, not an identity space. */
  readonly provider: string;
  readonly licence: string;
  /** Verbatim attribution string the UI must display while this tile is visible. */
  readonly attribution: string;
  readonly retrievedAt?: string;
  readonly datasetVersion?: string;
}

export interface EnvironmentProvenance {
  readonly geometryClass: EnvironmentGeometryClass;
  /** Which attribute produced the vertical extent, e.g. "tag:height", "tag:building:levels", "default". */
  readonly heightBasis?: string;
  /** Which attribute produced the horizontal width for linear features. */
  readonly widthBasis?: string;
}

export interface EnvironmentMesh {
  /**
   * Environment-local id, namespaced by provider ("env:osm:way/123"). It is NOT a Teldra canonical id
   * and NOT an IFC GlobalId; it resolves back to `source` only.
   */
  readonly envId: string;
  readonly kind: EnvironmentFeatureKind;
  /** ENU metres, xyz triples. */
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly provenance: EnvironmentProvenance;
  readonly source: { readonly provider: string; readonly externalId: string };
  /** Whether the mesh participates as a shadow caster in sun/shadow studies. */
  readonly castsShadow: boolean;
  /** Linear features are flat in ENU and expected to be draped on terrain by the adapter. */
  readonly drapeOnTerrain: boolean;
}

export interface EnvironmentBoundsEnu {
  readonly min: readonly [east: number, north: number, up: number];
  readonly max: readonly [east: number, north: number, up: number];
}

export interface EnvironmentDiagnostic {
  readonly externalId: string;
  readonly code: string;
  readonly message: string;
}

export interface EnvironmentTile {
  readonly schemaVersion: "0.1.0";
  readonly tileId: string;
  readonly frame: LocalEnuFrame;
  readonly source: EnvironmentSourceRecord;
  /** Level of detail; 0 is the coarsest. Tile pyramids and caching are adapter concerns. */
  readonly lod: number;
  readonly bounds: EnvironmentBoundsEnu;
  readonly meshes: readonly EnvironmentMesh[];
  readonly diagnostics: readonly EnvironmentDiagnostic[];
}

// --- Explicit, testable WGS84 -> local ENU conversion (no implicit axis conventions) ---------------

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

const rad = (d: number): number => (d * Math.PI) / 180;

function geodeticToEcef(latDeg: number, lonDeg: number, h: number): [number, number, number] {
  const lat = rad(latDeg);
  const lon = rad(lonDeg);
  const sinLat = Math.sin(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [
    (n + h) * Math.cos(lat) * Math.cos(lon),
    (n + h) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - E2) + h) * sinLat,
  ];
}

export function createLocalEnuFrame(origin: Wgs84Origin): LocalEnuFrame {
  return { kind: "local-enu", origin, axes: "east-north-up", unit: "metre" };
}

/** WGS84 geodetic (degrees, metres) to local ENU metres about `frame.origin`. Exact, not planar. */
export function wgs84ToEnu(
  frame: LocalEnuFrame,
  latitudeDeg: number,
  longitudeDeg: number,
  heightM: number = frame.origin.heightM,
): readonly [east: number, north: number, up: number] {
  const o = frame.origin;
  const [ox, oy, oz] = geodeticToEcef(o.latitudeDeg, o.longitudeDeg, o.heightM);
  const [x, y, z] = geodeticToEcef(latitudeDeg, longitudeDeg, heightM);
  const dx = x - ox;
  const dy = y - oy;
  const dz = z - oz;
  const lat = rad(o.latitudeDeg);
  const lon = rad(o.longitudeDeg);
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  return [
    -so * dx + co * dy,
    -sl * co * dx - sl * so * dy + cl * dz,
    cl * co * dx + cl * so * dy + sl * dz,
  ];
}
