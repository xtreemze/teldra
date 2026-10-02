export type CanonicalId = string;
export type IfcGlobalId = string;

export type BuildingElementKind =
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

export interface BuildingReference {
  id: CanonicalId;
  ifcGlobalId: IfcGlobalId;
  kind: BuildingElementKind;
  name?: string;
}

export type CapabilityKind =
  | "light"
  | "opening"
  | "sensor"
  | "climate"
  | "media"
  | "switch";

export interface TwinCapability {
  id: CanonicalId;
  kind: CapabilityKind;
  properties?: Readonly<Record<string, unknown>>;
}

export interface TwinDevice {
  id: CanonicalId;
  name: string;
  buildingRefId?: CanonicalId;
  capabilities: readonly TwinCapability[];
}

export interface ExternalBinding {
  id: CanonicalId;
  deviceId: CanonicalId;
  adapter: string;
  externalId: string;
  capabilityMap?: Readonly<Record<CanonicalId, string>>;
}

export interface TwinProject {
  schemaVersion: "0.1.0";
  building: {
    ifcSchema: "IFC4";
    refs: readonly BuildingReference[];
  };
  devices: readonly TwinDevice[];
  bindings: readonly ExternalBinding[];
}

export class TwinIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwinIntegrityError";
  }
}

export function assertTwinIntegrity(project: TwinProject): void {
  assertUnique(project.building.refs.map((value) => value.id), "building reference");
  assertUnique(project.building.refs.map((value) => value.ifcGlobalId), "IFC GlobalId");
  assertUnique(project.devices.map((value) => value.id), "device");
  assertUnique(project.bindings.map((value) => value.id), "binding");

  const buildingIds = new Set(project.building.refs.map((value) => value.id));
  const deviceIds = new Set(project.devices.map((value) => value.id));

  for (const device of project.devices) {
    if (device.buildingRefId !== undefined && !buildingIds.has(device.buildingRefId)) {
      throw new TwinIntegrityError(
        `Device "${device.id}" references unknown building object "${device.buildingRefId}".`,
      );
    }

    assertUnique(
      device.capabilities.map((value) => value.id),
      `capability on device "${device.id}"`,
    );
  }

  for (const binding of project.bindings) {
    if (!deviceIds.has(binding.deviceId)) {
      throw new TwinIntegrityError(
        `Binding "${binding.id}" references unknown device "${binding.deviceId}".`,
      );
    }
  }
}

function assertUnique(values: readonly string[], kind: string): void {
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      throw new TwinIntegrityError(`Duplicate ${kind} identity "${value}".`);
    }

    seen.add(value);
  }
}
