/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: canonical Teldra JSON Schema.
 * Run: pnpm schema:generate
 */

export interface SerializedTwin {
  schemaVersion: "0.1.0";
  building: {
    ifcSchema: "IFC4";
    refs: BuildingReference[];
  };
  devices: Device[];
  bindings: Binding[];
}
export interface BuildingReference {
  id: string;
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
  id: string;
  name: string;
  buildingRefId?: string;
  capabilities: Capability[];
}
export interface Capability {
  id: string;
  kind: "light" | "opening" | "sensor" | "climate" | "media" | "switch";
  properties?: {
    [k: string]: unknown;
  };
}
export interface Binding {
  id: string;
  deviceId: string;
  adapter: string;
  externalId: string;
  capabilityMap?: {
    [k: string]: string;
  };
}
