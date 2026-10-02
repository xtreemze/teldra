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
  const canonicalIds = [
    ...project.building.refs.map((value) => value.id),
    ...project.devices.flatMap((device) => [
      device.id,
      ...device.capabilities.map((capability) => capability.id),
    ]),
    ...project.bindings.map((value) => value.id),
  ];

  assertUnique(canonicalIds, "canonical");
  assertUnique(project.building.refs.map((value) => value.ifcGlobalId), "IFC GlobalId");

  const buildingIds = new Set(project.building.refs.map((value) => value.id));
  const devicesById = new Map(project.devices.map((value) => [value.id, value] as const));

  for (const device of project.devices) {
    if (device.buildingRefId !== undefined && !buildingIds.has(device.buildingRefId)) {
      throw new TwinIntegrityError(
        `Device "${device.id}" references unknown building object "${device.buildingRefId}".`,
      );
    }
  }

  for (const binding of project.bindings) {
    const device = devicesById.get(binding.deviceId);

    if (device === undefined) {
      throw new TwinIntegrityError(
        `Binding "${binding.id}" references unknown device "${binding.deviceId}".`,
      );
    }

    if (binding.capabilityMap === undefined) {
      continue;
    }

    const capabilityIds = new Set(device.capabilities.map((capability) => capability.id));

    for (const capabilityId of Object.keys(binding.capabilityMap)) {
      if (!capabilityIds.has(capabilityId)) {
        throw new TwinIntegrityError(
          `Binding "${binding.id}" maps unknown capability "${capabilityId}" on device "${device.id}".`,
        );
      }
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
