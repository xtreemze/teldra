import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Material } from "@babylonjs/core/Materials/material";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Scene } from "@babylonjs/core/scene";

/** Preserve source Phong appearance on an explicitly tagged derived SH3D scene.
 * Ordinary glTF/PBR assets retain their existing renderer path.
 */
export function sourceMaterialProjection(material: Material, scene: Scene): Material {
  const source = material.metadata?.gltf?.extras?.teldraSourceMaterial;
  if (source?.format !== "wavefront-mtl") return material;
  if (!(material instanceof PBRMaterial)) {
    throw new Error("SH3D source material requires a glTF PBR transport material.");
  }
  const vector = (key: string, fallback: number[], max = Infinity): Color3 => {
    const value: unknown = source[key] ?? fallback;
    if (!Array.isArray(value) || value.length !== 3 ||
        !value.every(x => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max)) {
      throw new Error(`Invalid SH3D source material ${key}.`);
    }
    return Color3.FromArray(value);
  };
  const scalar = (key: string, fallback: number, max = Infinity): number => {
    const value: unknown = source[key] ?? [fallback];
    if (!Array.isArray(value) || value.length !== 1 ||
        typeof value[0] !== "number" || !Number.isFinite(value[0]) || value[0] < 0 || value[0] > max) {
      throw new Error(`Invalid SH3D source material ${key}.`);
    }
    return value[0];
  };
  // Validate before allocating a GPU-side material.
  const diffuse = vector("Kd", [0.8, 0.8, 0.8], 1);
  const ambient = vector("Ka", [0, 0, 0]);
  const specular = vector("Ks", [0, 0, 0]);
  const power = scalar("Ns", 0);
  const alpha = scalar("d", 1, 1);
  const projected = new StandardMaterial(`${material.name}:source-phong`, scene);
  projected.diffuseColor = diffuse;
  projected.ambientColor = ambient;
  projected.specularColor = specular;
  projected.specularPower = power;
  projected.alpha = alpha;
  projected.backFaceCulling = material.backFaceCulling;
  projected.diffuseTexture = material.albedoTexture;
  projected.useAlphaFromDiffuseTexture = material.useAlphaFromAlbedoTexture;
  projected.transparencyMode = material.transparencyMode;
  projected.metadata = material.metadata;
  return projected;
}
