/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: canonical Teldra JSON Schema.
 * Run: pnpm schema:generate
 */

export type Id = string;

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
