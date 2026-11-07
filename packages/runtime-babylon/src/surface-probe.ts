import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { TwinRenderIdentity } from "./identity.js";

export interface SurfaceProbe {
  readonly canonicalId: string | null;
  readonly nodeKey: string | null;
  readonly mesh: string;
  readonly material: string | null;
  readonly materialType: string | null;
  readonly texture: string | null;
  readonly textureReady: boolean;
  readonly samplingMode: number | null;
  readonly anisotropy: number | null;
  readonly diffuseRgb: number[] | null;
  readonly originalKd: number[] | null;
  readonly worldPoint: number[] | null;
  readonly worldNormal: number[] | null;
  readonly uv: number[] | null;
  readonly distanceMetres: number;
}

/** Describes the *actual hit surface*, not the first valid source room material.
 * Read-only, with no texture sampling, GPU readback, state changes, or source edits.
 */
export function describeSurfacePick(picked: PickingInfo | null, identity: TwinRenderIdentity | null): SurfaceProbe | null {
  if (!picked?.hit || !picked.pickedMesh) return null;
  const mesh = picked.pickedMesh;
  const material = mesh.material;
  const standard = material instanceof StandardMaterial ? material : null;
  const pbr = material instanceof PBRMaterial ? material : null;
  const texture = standard?.diffuseTexture ?? pbr?.albedoTexture ?? null;
  const extras = material?.metadata?.gltf?.extras?.teldraSourceMaterial;
  const kd: unknown = extras?.Kd;
  // Never display a base64/data: URI or embedded binary in a diagnostic panel.
  const sourceName: unknown = extras?.map_Kd;
  const textureName = typeof sourceName === "string" && sourceName.length > 0 ? sourceName.slice(0, 120)
    : texture?.name?.startsWith("data:") ? "embedded texture" : texture?.name?.slice(0, 120) ?? null;
  const coordinates = picked.faceId >= 0 ? picked.getTextureCoordinates()?.asArray() ?? null : null;
  const normal = picked.faceId >= 0 ? picked.getNormal(true)?.asArray() ?? null : null;
  const rounded = (values: number[] | null): number[] | null => values?.map(v => Math.round(v * 10000) / 10000) ?? null;
  return {
    canonicalId: identity?.canonicalId ?? null,
    nodeKey: identity?.nodeKey ?? null,
    mesh: mesh.name.slice(0, 120),
    material: material?.name.slice(0, 120) ?? null,
    materialType: material?.getClassName() ?? null,
    texture: textureName,
    textureReady: texture?.isReady() ?? false,
    samplingMode: texture?.samplingMode ?? null,
    anisotropy: texture?.anisotropicFilteringLevel ?? null,
    diffuseRgb: rounded(standard?.diffuseColor.asArray() ?? pbr?.albedoColor.asArray() ?? null),
    originalKd: Array.isArray(kd) && kd.length === 3 && kd.every(v => typeof v === "number" && Number.isFinite(v)) ? rounded(kd as number[]) : null,
    worldPoint: rounded(picked.pickedPoint?.asArray() ?? null),
    worldNormal: rounded(normal),
    uv: rounded(coordinates),
    distanceMetres: Math.round(picked.distance * 1000) / 1000,
  };
}
