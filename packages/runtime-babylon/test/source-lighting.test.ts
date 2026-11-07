import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { applySourceLighting, assignSourceLights, applySourceLightPlacements } from "../src/source-lighting";

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

it("assigns local sources by mesh location independently of the camera", () => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  try {
    const profile = { profile: "sh3d-preview-v1", lightColor: 0x777777, skyColor: 0xcce4fc,
      pointSources: Array.from({length: 5}, (_, i) => ({ position: [i * 10, 0, 0], color: 0xffffff, power: 0.5 })) };
    applySourceLighting(profile, scene);
    const mesh = new Mesh("mesh", scene);
    mesh.position.x = 40;
    assignSourceLights(scene, [mesh]);
    const locals = scene.lights.slice(4);
    expect(locals[0]!.isEnabled()).toBe(false);
    expect(locals.slice(1).every(light => light.includedOnlyMeshes.includes(mesh))).toBe(true);
    expect(locals[1]!.intensity).toBe(0.5);
    const assigned = locals.map(light => light.includedOnlyMeshes.includes(mesh));
    const camera = new ArcRotateCamera("camera", 0, 1, 8, Vector3.Zero(), scene);
    scene.activeCamera = camera; camera.radius = 40;
    assignSourceLights(scene, [mesh]);
    expect(locals.map(light => light.includedOnlyMeshes.includes(mesh))).toEqual(assigned);
    expect(locals[1]!.intensity).toBe(0.5);
  } finally { scene.dispose(); engine.dispose(); }
});

it("validates local source metadata before creating any lights", () => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  try {
    expect(() => applySourceLighting({profile: "sh3d-preview-v1", lightColor: 0, skyColor: 0,
      windowSources: [{position: [0, 1, NaN], color: 0xffffff, power: 1}]}, scene)).toThrow();
    expect(scene.lights).toHaveLength(0);
  } finally { scene.dispose(); engine.dispose(); }
});


it("moves lamp sources from their original positions and restores them on undo", () => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  try {
    applySourceLighting({profile: "sh3d-preview-v1", lightColor: 0, skyColor: 0,
      pointSources: [{position: [1, 2, 3], color: 0xffffff, power: 0.5, canonicalId: "lamp"}]}, scene);
    const light = scene.lights[4] as PointLight;
    const placement = {canonicalId: "lamp", matrix: Matrix.Translation(4, 0, 0).asArray()};
    applySourceLightPlacements(scene, [placement], Matrix.Identity());
    expect(light.position.asArray()).toEqual([5, 2, 3]);
    applySourceLightPlacements(scene, [placement], Matrix.Identity());
    expect(light.position.asArray()).toEqual([5, 2, 3]);
    applySourceLightPlacements(scene, [], Matrix.Identity());
    expect(light.position.asArray()).toEqual([1, 2, 3]);
  } finally { scene.dispose(); engine.dispose(); }
});
