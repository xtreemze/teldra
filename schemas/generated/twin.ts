/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: canonical Teldra JSON Schema.
 * Run: pnpm schema:generate
 */

export type Id = string;
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
