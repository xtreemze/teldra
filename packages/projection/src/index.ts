import type {
  BuildingElementKind,
  CapabilityKind,
  CanonicalId,
  IfcGlobalId,
  TwinProject,
} from "@teldra/domain";

export type Vector3 = readonly [x: number, y: number, z: number];

export interface Transform3D {
  position: Vector3;
  rotationQuaternion: readonly [x: number, y: number, z: number, w: number];
  scale: Vector3;
}

export interface TwinObjectProjection {
  canonicalId: CanonicalId;
  source:
    | {
        kind: "building";
        ifcGlobalId: IfcGlobalId;
        elementKind: BuildingElementKind;
      }
    | {
        kind: "device";
        buildingRefId?: CanonicalId;
        capabilities: readonly CapabilityKind[];
      };
}

export interface TwinProjection {
  objects: readonly TwinObjectProjection[];
}

export interface LightingContribution {
  lightId: CanonicalId;
  textureId: string;
  intensity: number;
  color: readonly [red: number, green: number, blue: number];
}

export interface LightingProjection {
  environmentId: string;
  contributions: readonly LightingContribution[];
  reflectionState: {
    probeA: string;
    probeB?: string;
    blend?: number;
  };
}

export function createTwinProjection(project: TwinProject): TwinProjection {
  const buildingObjects: TwinObjectProjection[] = project.building.refs.map((reference) => ({
    canonicalId: reference.id,
    source: {
      kind: "building",
      ifcGlobalId: reference.ifcGlobalId,
      elementKind: reference.kind,
    },
  }));

  const devices: TwinObjectProjection[] = project.devices.map((device) => ({
    canonicalId: device.id,
    source: {
      kind: "device",
      ...(device.buildingRefId === undefined
        ? {}
        : { buildingRefId: device.buildingRefId }),
      capabilities: device.capabilities.map((capability) => capability.kind),
    },
  }));

  return {
    objects: [...buildingObjects, ...devices],
  };
}
