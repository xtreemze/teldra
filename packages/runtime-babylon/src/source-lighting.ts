import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

/** Derived interactive-view lighting. Does not interpret lamp power as automation. */
export function applySourceLighting(input: unknown, scene: Scene): boolean {
  if (input === undefined) return false;
  const profile = input as Record<string, unknown>;
  if (profile === null || profile.profile !== "sh3d-preview-v1") {
    throw new Error("Unsupported SH3D lighting profile.");
  }
  const color = (key: string): Color3 => {
    const value = profile[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffff) {
      throw new Error(`Invalid SH3D lighting ${key}.`);
    }
    return Color3.FromInts(value >>> 16, (value >>> 8) & 255, value & 255);
  };
  const tint = color("lightColor");
  const sky = color("skyColor");
  // SH3D interactive-view directions, in its exported right-handed Y-up frame.
  const directions = [[1.5, -0.8, -1], [-1.5, -0.8, -1], [0, -0.8, 1], [0, 1, 0]];
  directions.forEach((direction, index) => {
    const light = new DirectionalLight(`sh3d-preview-${index}`, Vector3.FromArray(direction), scene);
    light.diffuse = tint.scale(index === 3 ? 0.7 : 0.9);
    light.specular = light.diffuse.clone();
  });
  scene.ambientColor = new Color3(0.2, 0.2, 0.2);
  scene.clearColor = new Color4(sky.r, sky.g, sky.b, 1);
  return true;
}
