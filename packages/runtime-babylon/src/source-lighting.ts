import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { ScenePlacement } from "./furniture-gizmo.js";
import type { Scene } from "@babylonjs/core/scene";

const LOCAL_LIGHT_LIMIT = 4;
const LOCAL_LIGHT_PREFIX = "sh3d-local-";

/** Derived interactive-view lighting. Does not interpret lamp power as automation. */
export function applySourceLighting(input: unknown, scene: Scene): boolean {
  if (input === undefined) return false;
  const profile = input as Record<string, unknown>;
  if (profile === null || profile.profile !== "sh3d-preview-v1") {
    throw new Error("Unsupported SH3D lighting profile.");
  }
  const color = (value: unknown, key: string): Color3 => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffff) {
      throw new Error(`Invalid SH3D lighting ${key}.`);
    }
    return Color3.FromInts(value >>> 16, (value >>> 8) & 255, value & 255);
  };
  const tint = color(profile.lightColor, "lightColor");
  const sky = color(profile.skyColor, "skyColor");
  const sources = ["pointSources", "windowSources"].flatMap(key => {
    const items = profile[key] ?? [];
    if (!Array.isArray(items)) throw new Error(`Invalid SH3D lighting ${key}.`);
    return items.map((item: unknown) => {
      if (!item || typeof item !== "object") throw new Error(`Invalid SH3D lighting ${key}.`);
      const source = item as Record<string, unknown>;
      if (!Array.isArray(source.position) || source.position.length !== 3 ||
          !source.position.every(value => typeof value === "number" && Number.isFinite(value)) ||
          typeof source.power !== "number" || !Number.isFinite(source.power) || source.power < 0 || source.power > 1) {
        throw new Error(`Invalid SH3D lighting ${key}.`);
      }
      if (source.canonicalId !== undefined && (typeof source.canonicalId !== "string" || !source.canonicalId)) throw new Error(`Invalid SH3D lighting ${key}.`);
      return { position: Vector3.FromArray(source.position), color: color(source.color, key), power: source.power, canonicalId: source.canonicalId };
    });
  });
  const directions = [[1.5, -0.8, -1], [-1.5, -0.8, -1], [0, -0.8, 1], [0, 1, 0]];
  directions.forEach((direction, index) => {
    const light = new DirectionalLight(`sh3d-preview-${index}`, Vector3.FromArray(direction), scene);
    light.diffuse = tint.scale(index === 3 ? 0.7 : 0.9);
    light.specular = light.diffuse.clone();
  });
  sources.forEach((source, index) => {
    if (source.power === 0) return;
    const light = new PointLight(`${LOCAL_LIGHT_PREFIX}${index}`, source.position, scene);
    light.diffuse = source.color;
    light.specular = source.color.clone();
    light.intensity = source.power;
    light.metadata = { teldraSourceLight: { canonicalId: source.canonicalId, initialPosition: source.position.asArray() } };
    // Until assigned to geometry, an empty inclusion list would illuminate every mesh.
    light.setEnabled(false);
  });
  scene.ambientColor = new Color3(0.2, 0.2, 0.2);
  scene.clearColor = new Color4(sky.r, sky.g, sky.b, 1);
  return true;
}

/** Select local sources by each mesh's world-space centre, never by camera position. */
export function assignSourceLights(scene: Scene, meshes: readonly AbstractMesh[]): void {
  const lights = scene.lights.filter((light): light is PointLight =>
    light instanceof PointLight && light.name.startsWith(LOCAL_LIGHT_PREFIX));
  const assignments = new Map(lights.map(light => [light, [] as AbstractMesh[]]));
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    const center = mesh.getBoundingInfo().boundingBox.centerWorld;
    const nearest = [...lights].sort((a, b) =>
      Vector3.DistanceSquared(a.position, center) - Vector3.DistanceSquared(b.position, center));
    for (const light of nearest.slice(0, LOCAL_LIGHT_LIMIT)) assignments.get(light)!.push(mesh);
  }
  for (const [light, included] of assignments) {
    light.includedOnlyMeshes = included;
    light.setEnabled(included.length > 0);
  }
}


/** Apply canonical placement deltas to the immutable imported positions, including undo. */
export function applySourceLightPlacements(scene: Scene, placements: readonly ScenePlacement[], canonicalToScene: Matrix): void {
  const byId = new Map(placements.map(placement => [placement.canonicalId, placement]));
  for (const light of scene.lights) {
    if (!(light instanceof PointLight) || !light.name.startsWith(LOCAL_LIGHT_PREFIX)) continue;
    const source = light.metadata?.teldraSourceLight;
    if (!source) continue;
    const placement = byId.get(source.canonicalId);
    if (!placement) {
      light.position.copyFromFloats(...source.initialPosition as [number, number, number]);
      continue;
    }
    const delta = canonicalToScene.clone().invert().multiply(Matrix.FromArray(placement.matrix)).multiply(canonicalToScene);
    light.position.copyFrom(Vector3.TransformCoordinates(Vector3.FromArray(source.initialPosition), delta));
  }
}
