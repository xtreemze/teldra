import type { TeldraTwin } from "@teldra/contracts";

export type CanonicalId = string;
export type IfcGlobalId = string;

export type TwinProject = TeldraTwin;
export type BuildingReference = TwinProject["building"]["refs"][number];
export type BuildingElementKind = BuildingReference["kind"];
export type TwinDevice = TwinProject["devices"][number];
export type TwinCapability = TwinDevice["capabilities"][number];
export type CapabilityKind = TwinCapability["kind"];
export type ExternalBinding = TwinProject["bindings"][number];

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
