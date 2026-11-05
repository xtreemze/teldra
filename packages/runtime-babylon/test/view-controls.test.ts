import { describe, it, expect } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { cameraState, orientCamera, syncProjection, zoomCamera, panCamera, fitCamera, SceneLayers } from "../src/view-controls";

describe("disposable viewport controls", () => {
  it("orients, zooms, pans and fits without changing source transforms", () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    try {
      const camera = new ArcRotateCamera("camera", 0, 1, 10, Vector3.Zero(), scene);
      const mesh = CreateBox("wall", {}, scene); mesh.position.x = 4;
      orientCamera(camera, "+y"); expect(camera.beta).toBe(0.001);
      zoomCamera(camera, 0.5); expect(camera.radius).toBe(5);
      panCamera(camera, 1, 0); expect(camera.target.length()).toBeGreaterThan(0);
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA; syncProjection(camera, 2);
      expect(camera.orthoRight).toBeCloseTo(camera.orthoTop! * 2);
      expect(cameraState(camera).projection).toBe("orthographic");
      expect(cameraState(camera).axes).toHaveLength(6);
      expect(fitCamera(camera, [mesh])).toBe(true);
      expect(mesh.position.asArray()).toEqual([4, 0, 0]);
      mesh.setEnabled(false); expect(fitCamera(camera, [mesh])).toBe(false);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("composes category, level and source-hidden visibility without rewriting metadata", () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    try {
      const layers = new SceneLayers(); const mesh = CreateBox("wall", {}, scene);
      mesh.metadata = {gltf: {extras: {teldraSourceLayer: {levelId: "a", levelName: "Upper floor"}}}};
      const original = JSON.stringify(mesh.metadata);
      layers.add(mesh, "sh3d:wall:a", true); expect(mesh.isEnabled()).toBe(false);
      layers.setHiddenVisible(true); expect(mesh.isEnabled()).toBe(true);
      layers.setVisible("level:a", false); expect(mesh.isEnabled()).toBe(false);
      layers.setVisible("category:Walls", false); layers.setVisible("level:a", true);
      expect(mesh.isEnabled()).toBe(false);
      layers.setVisible("category:Walls", true); expect(mesh.isEnabled()).toBe(true);
      expect(JSON.stringify(mesh.metadata)).toBe(original);
      expect(layers.list()).toHaveLength(2);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
