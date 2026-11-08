import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

export type FloorMinificationMode = "auto" | "source" | "anisotropic" | "base-level";

/**
 * Presentation-only sampling policy for source-bound SH3D room-floor textures.
 * Preserve sampler parameters exactly; never change source UVs or images.
 * Device evidence in #100 confirms that only base-image sampling preserves
 * distant floors on affected WebGPU devices. Auto uses that compatibility path
 * on WebGPU, retaining source sampling on WebGL. Explicit modes remain available
 * for comparison. Base-image sampling can alias more than valid mipmaps.
 */
export class FloorMinificationInspector {
  private readonly originals = new Map<Texture, {samplingMode: number; anisotropic: number}>();
  private mode: FloorMinificationMode = "auto";
  constructor(private readonly maxAnisotropy: number, private readonly backend: "webgl" | "webgpu" = "webgl") {}
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
    if (!["auto", "source", "anisotropic", "base-level"].includes(value)) throw new Error("Unsupported floor minification mode.");
    this.mode = value;
    for (const texture of this.originals.keys()) this.apply(texture);
  }
  private apply(texture: Texture): void {
    const original=this.originals.get(texture);
    if (!original) return;
    const effective = this.mode === "auto" ? (this.backend === "webgpu" ? "base-level" : "source") : this.mode;
    const mode = effective === "source" ? original.samplingMode :
      effective === "anisotropic" ? Texture.TRILINEAR_SAMPLINGMODE : Texture.LINEAR_LINEAR;
    const aniso = effective === "source" ? original.anisotropic :
      effective === "anisotropic" ? Math.max(1, Math.min(this.maxAnisotropy, 8)) : 1;
    if (texture.samplingMode !== mode) texture.updateSamplingMode(mode);
    texture.anisotropicFilteringLevel = aniso;
  }
  restore(): void {
    this.setMode("source");
    this.originals.clear();
  }
}
