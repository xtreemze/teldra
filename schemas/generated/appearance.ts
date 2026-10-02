/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: canonical Teldra JSON Schema.
 * Run: pnpm schema:generate
 */

export type Sha256 = string;
export type TextureSemantic =
  "base-color" | "normal" | "occlusion" | "metallic-roughness" | "emissive";

export interface TeldraAppearanceManifest {
  schemaVersion: "0.1.0";
  sceneManifest: SourceManifest;
  profile: Profile;
  materials: Material[];
}
export interface SourceManifest {
  path: string;
  sha256: Sha256;
}
export interface Profile {
  materialModel: "metallic-roughness";
  primaryUvSet: 0;
  lightmapUvSet: 1;
  baseColorTransfer: "srgb";
  emissiveTransfer: "srgb";
  dataTextureTransfer: "linear";
  metallicRoughnessPacking: "g-roughness-b-metallic";
}
export interface Material {
  materialKey: string;
  nodeKeys: string[];
  textures: TextureBinding[];
}
export interface TextureBinding {
  semantic: TextureSemantic;
  uvSet: number;
  assetPath?: string;
  assetSha256?: Sha256;
}
