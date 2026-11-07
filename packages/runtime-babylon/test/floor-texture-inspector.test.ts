import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { FloorTextureInspector } from "../src/floor-texture-inspector";

describe("SH3D floor texture inspection", () => {
  it("uses the exact diffuse bitmap as a self-lit source and restores every original property", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const floor = new StandardMaterial("room:wood", scene);
      const image = RawTexture.CreateRGBTexture(new Uint8Array([196, 147, 92]), 1, 1, scene, false, false);
      floor.diffuseTexture = image;
      floor.diffuseColor = new Color3(0.25, 0.35, 0.45);
      floor.emissiveColor = new Color3(0.02, 0.03, 0.04);
      floor.disableLighting = false;
      floor.useEmissiveAsIllumination = false;
      const originalDiffuse = floor.diffuseColor.clone();
      const originalEmissive = floor.emissiveColor.clone();
      const originalMetadata = {source: "unchanged"};
      floor.metadata = originalMetadata;
      const inspection = new FloorTextureInspector();
      inspection.register(floor);
      inspection.register(floor);
      expect(inspection.materialCount).toBe(1);
      inspection.setEnabled(true);
      expect(floor.disableLighting).toBe(true);
      expect(floor.emissiveTexture).toBe(image);
      expect(floor.emissiveColor.asArray()).toEqual([1, 1, 1]);
      expect(floor.useEmissiveAsIllumination).toBe(true);
      expect(floor.diffuseTexture).toBe(image);
      expect(floor.diffuseColor.asArray()).toEqual(originalDiffuse.asArray());
      expect(floor.metadata).toBe(originalMetadata);
      expect(inspection.activeCount).toBe(1);
      inspection.setEnabled(false);
      expect(floor.disableLighting).toBe(false);
      expect(floor.emissiveTexture).toBeNull();
      expect(floor.emissiveColor.asArray()).toEqual(originalEmissive.asArray());
      expect(floor.useEmissiveAsIllumination).toBe(false);
      expect(floor.diffuseTexture).toBe(image);
      inspection.restore();
      expect(inspection.materialCount).toBe(0);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("does not register or mutate materials without diffuse images", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const material = new StandardMaterial("untextured-ceiling", scene);
      const inspector = new FloorTextureInspector();
      inspector.register(material);
      inspector.setEnabled(true);
      expect(inspector.materialCount).toBe(0);
      expect(material.disableLighting).toBe(false);
      expect(material.emissiveTexture).toBeNull();
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("preserves independently authored emissive channel and source lighting flags", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const material = new StandardMaterial("room", scene);
      const diffuse = RawTexture.CreateRGBTexture(new Uint8Array([128, 125, 120]), 1, 1, scene, false, false);
      const emissive = RawTexture.CreateRGBTexture(new Uint8Array([7, 8, 9]), 1, 1, scene, false, false);
      material.diffuseTexture = diffuse;
      material.emissiveTexture = emissive;
      material.emissiveColor = new Color3(0.2, 0.3, 0.4);
      material.disableLighting = true;
      material.useEmissiveAsIllumination = false;
      const inspector = new FloorTextureInspector();
      inspector.register(material);
      inspector.setEnabled(true);
      inspector.setEnabled(false);
      expect(material.emissiveTexture).toBe(emissive);
      expect(material.emissiveColor.asArray()).toEqual([0.2, 0.3, 0.4]);
      expect(material.disableLighting).toBe(true);
      expect(material.useEmissiveAsIllumination).toBe(false);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
