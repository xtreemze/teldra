import { expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { SourceTextureTransfer } from "../src/source-texture-transfer";

it("corrects only hardware-decoded source images, including reversible unlit inspection", () => {
  const engine=new NullEngine(); const scene=new Scene(engine);
  try {
    const material=new StandardMaterial("source",scene);
    const image=RawTexture.CreateRGBTexture(new Uint8Array([42,56,62]),1,1,scene,false,false);
    material.diffuseTexture=image;
    const plugin=new SourceTextureTransfer(material);
    const defines=new MaterialDefines() as MaterialDefines & {TELDRA_SOURCE_SRGB:boolean;TELDRA_SOURCE_EMISSIVE_SRGB:boolean};
    plugin.prepareDefines(defines);
    expect(defines.TELDRA_SOURCE_SRGB).toBe(false);
    image.getInternalTexture()!._useSRGBBuffer=true;
    plugin.prepareDefines(defines);
    expect(defines.TELDRA_SOURCE_SRGB).toBe(true);
    expect(defines.TELDRA_SOURCE_EMISSIVE_SRGB).toBe(false);
    material.disableLighting=true; material.useEmissiveAsIllumination=true; material.emissiveTexture=image;
    plugin.prepareDefines(defines);
    expect(defines.TELDRA_SOURCE_EMISSIVE_SRGB).toBe(true);
    material.disableLighting=false; material.emissiveTexture=null; plugin.prepareDefines(defines);
    expect(defines.TELDRA_SOURCE_EMISSIVE_SRGB).toBe(false);
    expect(material.diffuseTexture).toBe(image);
    expect(image.getInternalTexture()!._useSRGBBuffer).toBe(true);
  } finally {scene.dispose();engine.dispose();}
});

it("targets each pinned GLSL/WGSL emissive sample before composition", async () => {
  const {defaultPixelShader}=await import("@babylonjs/core/Shaders/default.fragment");
  const {defaultPixelShaderWGSL}=await import("@babylonjs/core/ShadersWGSL/default.fragment");
  const {ShaderLanguage}=await import("@babylonjs/core/Materials/shaderLanguage");
  const engine=new NullEngine(); const scene=new Scene(engine);
  try {
    const plugin=new SourceTextureTransfer(new StandardMaterial("source",scene));
    for (const [shader,language] of [[defaultPixelShader.shader,ShaderLanguage.GLSL],[defaultPixelShaderWGSL.shader,ShaderLanguage.WGSL]] as const) {
      const code=plugin.getCustomCode("fragment",language)!;
      const replacement=Object.entries(code).find(([key])=>key.startsWith("!"))!;
      expect([...shader.matchAll(new RegExp(replacement[0].slice(1),"g"))]).toHaveLength(1);
      expect(shader.indexOf("#define CUSTOM_FRAGMENT_UPDATE_ALPHA")).toBeLessThan(shader.indexOf("vColor.rgb", shader.indexOf("#define CUSTOM_FRAGMENT_UPDATE_ALPHA")));
      expect(shader.indexOf("#define CUSTOM_FRAGMENT_UPDATE_ALPHA")).toBeLessThan(shader.indexOf("baseColor.rgb*2.0"));
    }
  } finally {scene.dispose();engine.dispose();}
});

