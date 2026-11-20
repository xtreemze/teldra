/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: canonical Teldra JSON Schema.
 * Run: pnpm schema:generate
 */

export type Id = string;
/**
 * UTC RFC 3339 instant, e.g. 2026-01-02T03:04:05Z.
 */
export type Instant = string;
/**
 * @minItems 3
 * @maxItems 3
 */
export type Vector3 = [number, number, number];

export interface TeldraTwin {
  schemaVersion: "0.1.0";
  building: {
    ifcSchema: "IFC4";
    refs: BuildingReference[];
    sitePlacement?: SitePlacement;
  };
  devices: Device[];
  bindings: Binding[];
}
export interface BuildingReference {
  id: Id;
  ifcGlobalId: string;
  kind:
    | "site"
    | "building"
    | "storey"
    | "space"
    | "wall"
    | "slab"
    | "roof"
    | "door"
    | "window"
    | "furniture"
    | "fixture"
    | "distribution-element"
    | "other";
  name?: string;
}
/**
 * Provider-independent geographic placement of the building. The anchor is where the IFC local origin (0,0,0) sits on Earth; IFC geometry is never rewritten. Building local axes are X east, Y north (project north), Z up before orientation is applied.
 */
export interface SitePlacement {
  anchor: {
    crs: "EPSG:4326";
    latitudeDegrees: number;
    longitudeDegrees: number;
    height: {
      metres: number;
      /**
       * ellipsoidal: metres above the WGS84 ellipsoid. orthometric: metres above a named vertical datum (mean sea level); requires verticalDatum.
       */
      reference: "ellipsoidal" | "orthometric";
      verticalDatum?: string;
      /**
       * Ellipsoidal height minus orthometric height at the anchor. Required to derive an ellipsoidal height from an orthometric one.
       */
      geoidSeparationMetres?: number;
    };
  };
  orientation: {
    /**
     * Geographic (true) north, not grid north or magnetic north.
     */
    northReference: "geographic-north";
    /**
     * Clockwise bearing, in degrees from geographic north, of the building local +Y axis (project north).
     */
    projectNorthBearingDegrees: number;
  };
  provenance: {
    status: "provisional" | "user-confirmed";
    source: string;
    dataset: string;
    sourceObjectId?: string;
    retrievedAt: Instant;
    confirmedAt?: Instant;
    attribution?: string;
  };
}
export interface Device {
  id: Id;
  name: string;
  buildingRefId?: Id;
  capabilities: Capability[];
  /**
   * Device pose in the IFC world coordinate frame, in metres with Z up. Quaternion order is x, y, z, w.
   */
  placement?: {
    frame: "ifc-world-metres-z-up";
    position: Vector3;
    /**
     * @minItems 4
     * @maxItems 4
     */
    rotationQuaternion: [number, number, number, number];
  };
}
export interface Capability {
  id: Id;
  kind: "light" | "opening" | "sensor" | "climate" | "media" | "switch";
  properties?: {
    [k: string]: unknown;
  };
}
export interface Binding {
  id: Id;
  deviceId: Id;
  adapter: string;
  externalId: string;
  capabilityMap?: {
    [k: string]: string;
  };
}
