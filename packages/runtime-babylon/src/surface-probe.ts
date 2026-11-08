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


export interface GpuMipSample {
  readonly level: number;
  readonly size: readonly [number, number];
  readonly rgb: readonly [number, number, number] | null;
  readonly error: string | null;
  readonly coordinates?: readonly [number, number];
  readonly sampleLocation?: "picked UV" | "texture center";
}

export interface GpuFloorEvidence {
  readonly framebufferRgb: readonly [number, number, number] | null;
  readonly framebufferError: string | null;
  readonly mips: readonly GpuMipSample[];
  readonly textureSize: readonly [number, number] | null;
}

/** Map CSS coordinates to the current backend's framebuffer origin. */
export function clientToFramebufferPixel(clientX: number, clientY: number,
  rect: {left: number; top: number; width: number; height: number},
  width: number, height: number, backend: "webgpu" | "webgl"): [number, number] | null {
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height, width, height].every(Number.isFinite) ||
      rect.width <= 0 || rect.height <= 0 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || clientX < rect.left || clientY < rect.top ||
      clientX >= rect.left + rect.width || clientY >= rect.top + rect.height) return null;
  const x = Math.floor((clientX - rect.left) * width / rect.width);
  const y = Math.floor((clientY - rect.top) * height / rect.height);
  return [x, backend === "webgl" ? height - 1 - y : y];
}
/** Select only a base-level, middle-level and final 1px mip diagnostic.
 * We never read entire images, dump proprietary bitmaps or mutate sampling.
 */
export function diagnosticMipLevels(width: number, height: number): number[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 16384 || height > 16384) return [];
  const last = Math.floor(Math.log2(Math.max(width, height)));
  return [...new Set([0, Math.floor(last / 2), last])];
}

export function normalizeGpuRgb(data: ArrayBufferView | null, channelOrder: "rgba" | "bgra" = "rgba"): [number, number, number] | null {
  if (!data || data.byteLength < 3) return null;
  if (data instanceof Float32Array) {
    if (data.length < 3) return null;
    return (channelOrder === "bgra" ? [2, 1, 0] : [0, 1, 2]).map(i => Math.max(0, Math.min(255, Math.round((data[i] ?? 0) * 255)))) as [number, number, number];
  }
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    return channelOrder === "bgra" ? [data[2] ?? 0, data[1] ?? 0, data[0] ?? 0] : [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
  }
  return null;
}

/** Opt-in readback of *already bound GPU texture* mip-level texels.
 * readPixels is asynchronous for WebGPU and can be unavailable depending on
 * browser/GPU texture usage flags. Failures are recorded, never hidden or
 * interpreted as a black pixel.
 */
export async function inspectGpuMips(texture: import("@babylonjs/core/Materials/Textures/baseTexture").BaseTexture,
  uv?: readonly [number, number] | null): Promise<{
  readonly textureSize: readonly [number, number];
  readonly mips: readonly GpuMipSample[];
  readonly mipAvailabilityError?: string;
  readonly mipAvailability?: "allocated" | "inferred";
}> {
  const size = texture.getSize();
  const dims: [number, number] = [size.width, size.height];
  const candidates = diagnosticMipLevels(size.width, size.height);
  if (!candidates.length) return {textureSize:dims,mips:[],mipAvailabilityError:"Invalid texture dimensions"};
  const internal = texture.getInternalTexture();
  const engine = texture.getScene()?.getEngine();
  if (!engine) return {textureSize:dims,mips:[],mipAvailabilityError:"Texture engine unavailable"};
  const isWebGPU = engine.isWebGPU;
  const mipAvailability = isWebGPU ? "allocated" as const : "inferred" as const;
  // Babylon InternalTexture.mipLevelCount is not updated for all image textures.
  // WebGPU exposes the actual allocation on its underlying GPUTexture.
  const resource: unknown = internal?._hardwareTexture?.underlyingResource;
  const allocatedCount = resource && typeof resource === "object" && "mipLevelCount" in resource
    ? resource.mipLevelCount : undefined;
  const count = isWebGPU ? allocatedCount :
    internal ? (internal.generateMipMaps ? Math.floor(Math.log2(Math.max(size.width, size.height))) + 1 : 1) : undefined;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
    return {textureSize:dims,mips:[],mipAvailabilityError:"Allocated mip levels unavailable"};
  }
  const last = Math.min(count - 1, Math.floor(Math.log2(Math.max(size.width, size.height))));
  const levels = [...new Set([0, Math.floor(last / 2), last])];
  let location: "picked UV" | "texture center" = "texture center";
  let u = 0.5, v = 0.5;
  if (uv && uv.every(Number.isFinite)) {
    const matrix = texture.getTextureMatrix().m;
    // Babylon's material shaders multiply mat4 by vec4(uv, 1, 0).
    const transformedU = uv[0] * matrix[0]! + uv[1] * matrix[4]! + matrix[8]!;
    const transformedV = uv[0] * matrix[1]! + uv[1] * matrix[5]! + matrix[9]!;
    const wrap = (value: number, mode: number): number | null => {
      if (mode === 0) return Math.max(0, Math.min(1, value));
      if (mode === 1) return value - Math.floor(value);
      if (mode === 2) { const period = ((value % 2) + 2) % 2; return period <= 1 ? period : 2 - period; }
      return null;
    };
    const mappedU = wrap(transformedU, texture.wrapU), mappedV = wrap(transformedV, texture.wrapV);
    if (mappedU !== null && mappedV !== null && Number.isFinite(mappedU) && Number.isFinite(mappedV)) {
      u = mappedU; v = mappedV; location = "picked UV";
    }
  }
  const result: GpuMipSample[] = [];
  for (const level of levels) {
    const width = Math.max(1, Math.floor(size.width / Math.pow(2, level)));
    const height = Math.max(1, Math.floor(size.height / Math.pow(2, level)));
    const x = Math.min(width - 1, Math.floor(u * width));
    const y = Math.min(height - 1, Math.floor(v * height));
    const coordinates: [number, number] = [x,y];
    try {
      const raw = await texture.readPixels(0, level, null, true, false, x, y, 1, 1);
      const rgb = normalizeGpuRgb(raw ?? null);
      result.push({level, size:[width,height], coordinates, sampleLocation:location, rgb,
        error: rgb ? null : "GPU texture readback returned no compatible pixel data"});
    } catch (reason) {
      result.push({level,size:[width,height],coordinates,sampleLocation:location,rgb:null,
        error: reason instanceof Error ? reason.message.slice(0, 240) : "GPU texture readback unsupported"});
    }
  }
  return {textureSize:dims,mips:result,mipAvailability};
}
