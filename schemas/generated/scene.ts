/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: canonical Teldra JSON Schema.
 * Run: pnpm schema:generate
 */

/**
 * @minItems 16
 * @maxItems 16
 */
export type Matrix4 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface TeldraSceneManifest {
  schemaVersion: "0.1.0";
  coordinateSystem: CoordinateSystem;
  source: SourceArtifact;
  scene: SceneArtifact;
  nodes: SceneNode[];
  lightingManifestPath?: string;
}
export interface CoordinateSystem {
  unit: "metre";
  handedness: "right";
  upAxis: "Z";
}
export interface SourceArtifact {
  buildingPath: string;
  buildingSha256: string;
}
export interface SceneArtifact {
  assetPath: string;
  assetSha256: string;
  format: "glb";
  canonicalToScene: Matrix4;
}
export interface SceneNode {
  nodeKey: string;
  canonicalId: string;
  ifcGlobalId?: string;
  kind: "building" | "device" | "presentation";
  renderPart?: string;
  canonicalToNode?: Matrix4;
}
