import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Scene } from "@babylonjs/core/scene";
import { applyPreviewShadowDetail, SH3D_EDITING_SHADOW_DETAIL } from "../src/preview-shadow-detail";

describe("Studio SH3D shadow detail", () => {
  it("lifts shadows without changing source materials or lighting and restores ungraded output", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const floor = new StandardMaterial("floor", scene);
      floor.diffuseColor = new Color3(0.03, 0.025, 0.02);
      const sourceColor = floor.diffuseColor.clone();
      const sourceAmbient = scene.ambientColor.clone();
      const sourceLights = scene.lights.length;
      applyPreviewShadowDetail(scene, SH3D_EDITING_SHADOW_DETAIL);
      const image = scene.imageProcessingConfiguration;
      expect(image.colorCurvesEnabled).toBe(true);
      expect(image.colorCurves?.shadowsExposure).toBe(SH3D_EDITING_SHADOW_DETAIL);
      expect(image.colorCurves?.midtonesExposure).toBeCloseTo(SH3D_EDITING_SHADOW_DETAIL * 0.12);
      expect(image.colorCurves?.highlightsExposure).toBe(0);
      expect(floor.diffuseColor.asArray()).toEqual(sourceColor.asArray());
      expect(scene.ambientColor.asArray()).toEqual(sourceAmbient.asArray());
      expect(scene.lights).toHaveLength(sourceLights);
      applyPreviewShadowDetail(scene, 0);
      expect(image.colorCurvesEnabled).toBe(false);
      expect(floor.diffuseColor.asArray()).toEqual(sourceColor.asArray());
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("rejects invalid values without modifying image processing", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      for (const value of [-1, 101, NaN, Infinity]) {
        expect(() => applyPreviewShadowDetail(scene, value)).toThrow("Shadow detail");
      }
      expect(scene.imageProcessingConfiguration.colorCurvesEnabled).toBe(false);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
