import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

/** glTF color images may use hardware sRGB decoding. StandardMaterial's
 * legacy Phong shader expects encoded samples, unlike the PBR transport.
 * Undo that decode at the consumer, preserving the shared image and its mips.
 */
export class SourceTextureTransfer extends MaterialPluginBase {
  constructor(private readonly source: StandardMaterial) {
    super(source, "TeldraSourceTextureTransfer", 200, {
      TELDRA_SOURCE_SRGB: false, TELDRA_SOURCE_EMISSIVE_SRGB: false,
    }, true, true);
  }

  override isCompatible(): boolean { return true; }

  override prepareDefines(defines: MaterialDefines): void {
    const srgb = this.source.diffuseTexture?.getInternalTexture()?._useSRGBBuffer === true;
    Object.assign(defines, {
      TELDRA_SOURCE_SRGB: srgb,
      TELDRA_SOURCE_EMISSIVE_SRGB: this.source.emissiveTexture?.getInternalTexture()?._useSRGBBuffer === true,
    });
  }

  override getCustomCode(shaderType: string, language = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== "fragment") return null;
    const wgsl = language === ShaderLanguage.WGSL;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: wgsl ? `
fn teldraSourceEncode(c: vec3f) -> vec3f {
  return select(12.92*c, 1.055*pow(max(c, vec3f(0.0)), vec3f(1.0/2.4))-0.055, c > vec3f(0.0031308));
}
fn teldraSourceEmissive(c: vec4f) -> vec4f {
#ifdef TELDRA_SOURCE_EMISSIVE_SRGB
  return vec4f(teldraSourceEncode(c.rgb), c.a);
#else
  return c;
#endif
}` : `
vec3 teldraSourceEncode(vec3 c) {
  return mix(12.92*c, 1.055*pow(max(c, vec3(0.0)), vec3(1.0/2.4))-0.055, step(vec3(0.0031308), c));
}
vec4 teldraSourceEmissive(vec4 c) {
#ifdef TELDRA_SOURCE_EMISSIVE_SRGB
  return vec4(teldraSourceEncode(c.rgb), c.a);
#else
  return c;
#endif
}`,
      CUSTOM_FRAGMENT_UPDATE_ALPHA: `
#if defined(TELDRA_SOURCE_SRGB) && defined(DIFFUSE)
${wgsl ? "baseColor = vec4f(teldraSourceEncode(baseColor.rgb), baseColor.a);" : "baseColor.rgb = teldraSourceEncode(baseColor.rgb);"}
#endif`,
      // Babylon has no emissive-sample injection point. Wrap that one sample,
      // before its intensity, authored emissive color or other lighting is added.
      "!TEXRD\\(emissiveSampler,[^;]+?\\)": "teldraSourceEmissive($0)",
    };
  }
}
