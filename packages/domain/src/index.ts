import type { TeldraTwin } from "@teldra/schemas/types/twin";

export type TwinProject = TeldraTwin;

export type CanonicalId = string;
export type BuildingReference = TwinProject["building"]["refs"][number];
export type IfcGlobalId = BuildingReference["ifcGlobalId"];
export type BuildingElementKind = BuildingReference["kind"];

export type TwinDevice = TwinProject["devices"][number];
export type TwinCapability = TwinDevice["capabilities"][number];
export type CapabilityKind = TwinCapability["kind"];

export type ExternalBinding = TwinProject["bindings"][number];

type GeneratedSitePlacement = NonNullable<TwinProject["building"]["sitePlacement"]>;
/** Mapped (not interface) so it is assignable to JSON command payloads. */
export type SitePlacement = { [K in keyof GeneratedSitePlacement]: GeneratedSitePlacement[K] };
export type SitePlacementStatus = SitePlacement["provenance"]["status"];
export type SiteHeight = SitePlacement["anchor"]["height"];

export class TwinIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwinIntegrityError";
  }
}

export class SitePlacementError extends TwinIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = "SitePlacementError";
  }
}

/**
 * Semantic checks the JSON Schema cannot express. Orientation is a clockwise
 * bearing of building +Y (project north) from geographic north in [0, 360).
 */
export function assertSitePlacement(placement: SitePlacement): void {
  const { anchor, orientation, provenance } = placement;
  const { latitudeDegrees: lat, longitudeDegrees: lon, height } = anchor;
  if (![lat, lon, height.metres, orientation.projectNorthBearingDegrees].every(Number.isFinite))
    throw new SitePlacementError("Site placement requires finite anchor coordinates, height and bearing.");
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180)
    throw new SitePlacementError("Site placement anchor is outside WGS84 bounds.");
  if (height.geoidSeparationMetres !== undefined && !Number.isFinite(height.geoidSeparationMetres))
    throw new SitePlacementError("Site placement geoid separation must be finite.");
  if (height.reference === "orthometric" && (height.verticalDatum ?? "").length === 0)
    throw new SitePlacementError("Orthometric site heights require a named vertical datum.");
  const bearing = orientation.projectNorthBearingDegrees;
  if (bearing < 0 || bearing >= 360)
    throw new SitePlacementError("Project-north bearing must be within [0, 360) degrees.");
  const confirmed = provenance.status === "user-confirmed";
  if (confirmed !== (provenance.confirmedAt !== undefined))
    throw new SitePlacementError("Site placement confirmedAt must be present exactly when status is user-confirmed.");
}

export function assertTwinIntegrity(project: TwinProject): void {
  if (project.building.sitePlacement !== undefined) assertSitePlacement(project.building.sitePlacement);
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
    if (device.placement !== undefined) {
      const { frame, position, rotationQuaternion: q } = device.placement;
      if (frame !== "ifc-world-metres-z-up" || position.length !== 3 || q.length !== 4 || ![...position, ...q].every(Number.isFinite) || Math.abs(Math.hypot(...q) - 1) > 1e-6) {
        throw new TwinIntegrityError(`Device "${device.id}" has an invalid placement.`);
      }
    }
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
