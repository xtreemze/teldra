import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { applySourceLighting } from "../src/source-lighting";

describe("SH3D preview lighting", () => {
  it("uses source brightness, sky and four directional lights with ambient fill", () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    try {
      const profile = {profile: "sh3d-preview-v1", lightColor: 0x777777, skyColor: 0xcce4fc};
      expect(applySourceLighting(profile, scene)).toBe(true);
      expect(scene.lights).toHaveLength(4);
      expect(scene.lights[0]?.diffuse.r).toBeCloseTo(0.9 * 119 / 255);
      expect(scene.lights[3]?.diffuse.r).toBeCloseTo(0.7 * 119 / 255);
      expect(scene.ambientColor.asArray()).toEqual([0.2, 0.2, 0.2]);
      expect(scene.clearColor.r).toBeCloseTo(204 / 255);
      expect(scene.lights.map(light => light.getClassName())).toEqual(Array(4).fill("DirectionalLight"));
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("leaves ordinary scenes alone and rejects malformed profiles before mutation", () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    try {
      expect(applySourceLighting(undefined, scene)).toBe(false);
      expect(() => applySourceLighting({profile: "sh3d-preview-v1", lightColor: -1}, scene)).toThrow();
      expect(scene.lights).toHaveLength(0);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
