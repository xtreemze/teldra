/**
 * WGS84 site positioning without coupling canonical building geometry to a map
 * renderer. All heights here are metres above the WGS84 ellipsoid (NOT mean
 * sea level). Local building axes: X east, Y north, Z up before site rotation.
 * Yaw rotates clockwise about Up, measured from that default orientation.
 */
export interface GeodeticAnchor {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly ellipsoidalHeightMetres: number;
  readonly clockwiseYawRadians: number;
}
export type WorldPoint = readonly [number, number, number];

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const RAD = Math.PI / 180;

export function assertGeodeticAnchor(anchor: GeodeticAnchor): void {
  if (![anchor.latitudeDegrees, anchor.longitudeDegrees,
    anchor.ellipsoidalHeightMetres, anchor.clockwiseYawRadians].every(Number.isFinite))
    throw new Error("Georeference requires finite WGS84 coordinates, height and yaw.");
  if (Math.abs(anchor.latitudeDegrees) > 90 ||
      anchor.longitudeDegrees < -180 || anchor.longitudeDegrees > 180)
    throw new Error("Georeference latitude or longitude is outside WGS84 bounds.");
  if (Math.abs(anchor.ellipsoidalHeightMetres) > 100000)
    throw new Error("Georeference ellipsoidal height is outside supported bounds.");
}

function assertPoint(point: WorldPoint): void {
  if (point.length !== 3 || !point.every(Number.isFinite))
    throw new Error("World point must contain three finite coordinates.");
}

/** Latitude and longitude in degrees; altitude relative to the ellipsoid. */
export function geodeticToEcef(latitudeDegrees: number, longitudeDegrees: number, ellipsoidalHeightMetres: number): WorldPoint {
  assertGeodeticAnchor({ latitudeDegrees, longitudeDegrees, ellipsoidalHeightMetres, clockwiseYawRadians: 0 });
  const lat = latitudeDegrees * RAD;
  const lon = longitudeDegrees * RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [
    (n + ellipsoidalHeightMetres) * cosLat * Math.cos(lon),
    (n + ellipsoidalHeightMetres) * cosLat * Math.sin(lon),
    (n * (1 - E2) + ellipsoidalHeightMetres) * sinLat,
  ];
}

/** Local East/North/Up metre offsets relative to the given WGS84 anchor. */
export function enuToEcef(anchor: GeodeticAnchor, eastNorthUp: WorldPoint): WorldPoint {
  assertGeodeticAnchor(anchor);
  assertPoint(eastNorthUp);
  const lat = anchor.latitudeDegrees * RAD;
  const lon = anchor.longitudeDegrees * RAD;
  const [east, north, up] = eastNorthUp;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const [x, y, z] = geodeticToEcef(anchor.latitudeDegrees, anchor.longitudeDegrees, anchor.ellipsoidalHeightMetres);
  return [
    x - sinLon * east - sinLat * cosLon * north + cosLat * cosLon * up,
    y + cosLon * east - sinLat * sinLon * north + cosLat * sinLon * up,
    z + cosLat * north + sinLat * up,
  ];
}

export function ecefToEnu(anchor: GeodeticAnchor, ecef: WorldPoint): WorldPoint {
  assertGeodeticAnchor(anchor);
  assertPoint(ecef);
  const [x, y, z] = geodeticToEcef(anchor.latitudeDegrees, anchor.longitudeDegrees, anchor.ellipsoidalHeightMetres);
  const dx = ecef[0] - x, dy = ecef[1] - y, dz = ecef[2] - z;
  const lat = anchor.latitudeDegrees * RAD;
  const lon = anchor.longitudeDegrees * RAD;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  return [
    -sinLon * dx + cosLon * dy,
    -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz,
    cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz,
  ];
}

/** Place a BIM local XYZ metre point in ECEF without modifying the IFC point. */
export function buildingLocalToEcef(anchor: GeodeticAnchor, local: WorldPoint): WorldPoint {
  assertGeodeticAnchor(anchor);
  assertPoint(local);
  const cos = Math.cos(anchor.clockwiseYawRadians);
  const sin = Math.sin(anchor.clockwiseYawRadians);
  return enuToEcef(anchor, [
    cos * local[0] + sin * local[1],
    -sin * local[0] + cos * local[1],
    local[2],
  ]);
}

export function ecefToBuildingLocal(anchor: GeodeticAnchor, ecef: WorldPoint): WorldPoint {
  const [east, north, up] = ecefToEnu(anchor, ecef);
  const cos = Math.cos(anchor.clockwiseYawRadians);
  const sin = Math.sin(anchor.clockwiseYawRadians);
  return [cos * east - sin * north, sin * east + cos * north, up];
}
