import { Camera } from "@babylonjs/core/Cameras/camera";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

export type ViewDirection = "isometric" | "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
export type ViewProjection = "perspective" | "orthographic";
export interface ViewState {
  alpha: number; beta: number; radius: number; target: number[];
  projection: ViewProjection;
  axes: {direction: ViewDirection; label: string; x: number; y: number; depth: number}[];
}

export function cameraState(camera: ArcRotateCamera): ViewState {
  const matrix = camera.getViewMatrix();
  const axes: ViewState["axes"] = [];
  for (const [index, label] of ["x", "y", "z"].entries()) {
    for (const sign of [1, -1]) {
      const axis = Vector3.Zero();
      if (index === 0) axis.x = sign;
      if (index === 1) axis.y = sign;
      if (index === 2) axis.z = sign;
      const projected = Vector3.TransformNormal(axis, matrix);
      axes.push({direction: `${sign === 1 ? "+" : "-"}${label}` as ViewDirection,
        label: `${sign === 1 ? "+" : "-"}${label.toUpperCase()}`,
        x: projected.x * 37, y: -projected.y * 37, depth: projected.z});
    }
  }
  return {alpha: camera.alpha, beta: camera.beta, radius: camera.radius,
    target: camera.target.asArray(),
    projection: camera.mode === Camera.ORTHOGRAPHIC_CAMERA ? "orthographic" : "perspective", axes};
}

export function stopCameraMotion(camera: ArcRotateCamera): void {
  camera.inertialAlphaOffset = camera.inertialBetaOffset = camera.inertialRadiusOffset = 0;
  camera.inertialPanningX = camera.inertialPanningY = 0;
}

export function orientCamera(camera: ArcRotateCamera, direction: ViewDirection): void {
  stopCameraMotion(camera);
  const views: Record<ViewDirection, [number, number]> = {
    isometric: [-Math.PI / 4, Math.PI / 3],
    "+x": [0, Math.PI / 2], "-x": [Math.PI, Math.PI / 2],
    "+y": [-Math.PI / 2, 0.001], "-y": [-Math.PI / 2, Math.PI - 0.001],
    "+z": [Math.PI / 2, Math.PI / 2], "-z": [-Math.PI / 2, Math.PI / 2],
  };
  [camera.alpha, camera.beta] = views[direction];
}

export function syncProjection(camera: ArcRotateCamera, aspect: number): void {
  if (camera.mode !== Camera.ORTHOGRAPHIC_CAMERA) return;
  const height = camera.radius * Math.tan(camera.fov / 2);
  camera.orthoTop = height; camera.orthoBottom = -height;
  camera.orthoLeft = -height * aspect; camera.orthoRight = height * aspect;
}

export function zoomCamera(camera: ArcRotateCamera, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  stopCameraMotion(camera);
  camera.radius = Math.max(camera.lowerRadiusLimit ?? 0.01,
    Math.min(camera.upperRadiusLimit ?? 1e7, camera.radius * factor));
}

export function panCamera(camera: ArcRotateCamera, right: number, up: number): void {
  stopCameraMotion(camera);
  const inverse = camera.getViewMatrix().clone().invert();
  const delta = Vector3.TransformNormal(new Vector3(right, up, 0), inverse).scale(camera.radius * 0.1);
  camera.setTarget(camera.target.add(delta));
}

export function fitCamera(camera: ArcRotateCamera, meshes: AbstractMesh[]): boolean {
  const visible = meshes.filter(mesh => mesh.isEnabled() && mesh.getTotalVertices() > 0);
  if (!visible.length) return false;
  stopCameraMotion(camera);
  for (const mesh of visible) mesh.computeWorldMatrix(true);
  camera.zoomOn(visible);
  camera.radius = Math.max(camera.lowerRadiusLimit ?? 0.01, camera.radius * 1.15);
  camera.minZ = Math.max(0.001, camera.radius / 10000);
  camera.maxZ = Math.max(1000, camera.radius * 100);
  return true;
}

export interface ViewLayer { id: string; label: string; group: "category" | "level"; visible: boolean; meshParts: number }
export class SceneLayers {
  private readonly layers = new Map<string, ViewLayer>();
  private readonly memberships = new Map<AbstractMesh, string[]>();
  private readonly hidden = new Set<AbstractMesh>();
  private revealHidden = false;

  add(mesh: AbstractMesh, canonicalId: string, hidden: boolean): void {
    const source = mesh.metadata?.gltf?.extras?.teldraSourceLayer;
    const prefix = canonicalId.replace(/^sh3d:/, "").split(":")[0];
    const category = ({wall: "Walls", room: "Floors and ceilings", pieceOfFurniture: "Furniture",
      furniture: "Furniture", shelfUnit: "Furniture", doorOrWindow: "Doors and windows",
      light: "Light fixtures", device: "Devices", presentation: "Ground and background"} as Record<string, string>)[prefix ?? ""] ?? "Building";
    const id = `category:${category}`;
    const ids = [id]; this.addLayer(id, category, "category");
    if (typeof source?.levelId === "string" && typeof source?.levelName === "string") {
      const level = `level:${source.levelId}`; ids.push(level);
      this.addLayer(level, source.levelName, "level");
    }
    this.memberships.set(mesh, ids);
    if (hidden) this.hidden.add(mesh);
    this.apply(mesh, ids);
  }
  private addLayer(id: string, label: string, group: ViewLayer["group"]): void {
    const layer = this.layers.get(id);
    if (layer) layer.meshParts++;
    else this.layers.set(id, {id, label, group, visible: true, meshParts: 1});
  }
  private apply(mesh: AbstractMesh, ids: string[]): void {
    mesh.setEnabled((this.revealHidden || !this.hidden.has(mesh)) && ids.every(id => this.layers.get(id)?.visible));
  }
  list(): ViewLayer[] { return [...this.layers.values()].map(layer => ({...layer})); }
  setVisible(id: string, visible: boolean): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.visible = visible; this.refresh();
  }
  setHiddenVisible(visible: boolean): void { this.revealHidden = visible; this.refresh(); }
  private refresh(): void { for (const [mesh, ids] of this.memberships) this.apply(mesh, ids); }
}
