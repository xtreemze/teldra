import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";

/**
 * Renderer-only, reversible inspection of SH3D room textures.
 *
 * disableLighting alone is insufficient: without an emissive channel a
 * StandardMaterial can still output black. Explicitly display the exact
 * already-loaded diffuse image through the self-illuminating channel.
 */
export class FloorTextureInspector {
  private readonly originals = new Map<StandardMaterial, {
    disableLighting: boolean;
    emissiveColor: Color3;
    ambientColor: Color3;
    emissiveTexture: BaseTexture | null;
    useEmissiveAsIllumination: boolean;
    sourceDiffuseTexture: BaseTexture;
  }>();
  private inspecting = false;

  register(material: StandardMaterial): void {
    if (this.originals.has(material) || !material.diffuseTexture) return;
    this.originals.set(material, {
      disableLighting: material.disableLighting,
      emissiveColor: material.emissiveColor.clone(),
      ambientColor: material.ambientColor.clone(),
      emissiveTexture: material.emissiveTexture,
      useEmissiveAsIllumination: material.useEmissiveAsIllumination,
      sourceDiffuseTexture: material.diffuseTexture,
    });
    if (this.inspecting) this.apply(material);
  }

  get materialCount(): number { return this.originals.size; }
  get activeCount(): number {
    return [...this.originals.keys()].filter(material => material.disableLighting &&
      material.emissiveTexture === this.originals.get(material)!.sourceDiffuseTexture).length;
  }
  get enabled(): boolean { return this.inspecting; }

  setEnabled(value: boolean): void {
    this.inspecting = value;
    for (const material of this.originals.keys()) this.apply(material);
  }

  private apply(material: StandardMaterial): void {
    const source = this.originals.get(material);
    if (!source) return;
    if (this.inspecting) {
      // Keep diffuse map, UV coordinates, colors, transforms and geometry intact.
      // This is explicitly NOT a source material or scene lighting adjustment.
      material.emissiveTexture = source.sourceDiffuseTexture;
      // StandardMaterial adds the emissive color to the image sample.
      material.emissiveColor = Color3.Black();
      material.ambientColor = Color3.Black();
      material.useEmissiveAsIllumination = true;
      material.disableLighting = true;
    } else {
      material.disableLighting = source.disableLighting;
      material.emissiveTexture = source.emissiveTexture;
      material.emissiveColor = source.emissiveColor.clone();
      material.ambientColor = source.ambientColor.clone();
      material.useEmissiveAsIllumination = source.useEmissiveAsIllumination;
    }
  }

  restore(): void {
    this.setEnabled(false);
    this.originals.clear();
  }
}
