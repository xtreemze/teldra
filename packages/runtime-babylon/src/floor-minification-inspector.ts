import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

export type FloorMinificationMode = "source" | "anisotropic" | "base-level";

/**
 * Presentation-only A/B test for source-bound SH3D room-floor textures.
 * Preserve sampler parameters exactly; never change source UVs or images.
 * The base-level option bypasses mipmaps for diagnosis only: its aliasing and
 * cache/memory drawbacks make it inappropriate as the default.
 */
export class FloorMinificationInspector {
  private readonly originals = new Map<Texture, {samplingMode: number; anisotropic: number}>();
  private mode: FloorMinificationMode = "source";
  constructor(private readonly maxAnisotropy: number) {}
  register(material: StandardMaterial): void {
    const texture = material.diffuseTexture;
    if (!(texture instanceof Texture) || this.originals.has(texture)) return;
    this.originals.set(texture, {
      samplingMode: texture.samplingMode,
      anisotropic: texture.anisotropicFilteringLevel,
    });
    this.apply(texture);
  }
  get textureCount(): number {return this.originals.size;}
  get currentMode(): FloorMinificationMode {return this.mode;}
  setMode(value: FloorMinificationMode): void {
    if (!["source", "anisotropic", "base-level"].includes(value)) throw new Error("Unsupported floor minification mode.");
    this.mode = value;
    for (const texture of this.originals.keys()) this.apply(texture);
  }
  private apply(texture: Texture): void {
    const original=this.originals.get(texture);
    if (!original) return;
    const mode = this.mode === "source" ? original.samplingMode :
      this.mode === "anisotropic" ? Texture.TRILINEAR_SAMPLINGMODE : Texture.LINEAR_LINEAR;
    const aniso = this.mode === "source" ? original.anisotropic :
      this.mode === "anisotropic" ? Math.max(1, Math.min(this.maxAnisotropy, 8)) : 1;
    if (texture.samplingMode !== mode) texture.updateSamplingMode(mode);
    texture.anisotropicFilteringLevel = aniso;
  }
  restore(): void {
    this.setMode("source");
    this.originals.clear();
  }
}
