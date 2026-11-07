import { GizmoManager } from "@babylonjs/core/Gizmos/gizmoManager";
import { GizmoCoordinatesMode } from "@babylonjs/core/Gizmos/gizmo";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

/** IFC world metres, right-handed Z-up. This is an edit draft, not canonical state. */
export interface FurnitureWorldPose { position: readonly [number, number, number]; yawRadians: number }
export interface FurniturePlacement { canonicalId: string; original: FurnitureWorldPose; current: FurnitureWorldPose }
export interface ScenePlacement { canonicalId: string; matrix: readonly number[] }
export interface FurnitureEditSession {
  setPose(pose: FurnitureWorldPose): void;
  setMode(mode: "translate" | "rotate"): void;
  /** Constrain pointer handles to an IFC-world axis when the scene frame is axis-aligned. */
  setAxisConstraint(axis: "x" | "y" | "z" | null): boolean;
  setSnap(translationMetres: number, rotationRadians: number): void;
  cancel(): void;
  detach(): void;
}

function poseMatrix(pose: FurnitureWorldPose): Matrix {
  if (![...pose.position, pose.yawRadians].every(Number.isFinite)) throw new Error("Invalid furniture pose.");
  return Matrix.RotationZ(pose.yawRadians).multiply(Matrix.Translation(...pose.position));
}

function validateFrame(frame: Matrix): void {
  const axes = [Vector3.Right(), Vector3.Up(), Vector3.Forward()].map(axis => Vector3.TransformNormal(axis, frame));
  const values = frame.asArray();
  if (Math.abs(values[3]!) > 1e-5 || Math.abs(values[7]!) > 1e-5 ||
      Math.abs(values[11]!) > 1e-5 || Math.abs(values[15]! - 1) > 1e-5 ||
      frame.determinant() < 0.99999 || frame.determinant() > 1.00001 ||
      axes.some(axis => Math.abs(axis.length() - 1) > 1e-5) ||
      Math.abs(Vector3.Dot(axes[0]!, axes[1]!)) > 1e-5 ||
      Math.abs(Vector3.Dot(axes[0]!, axes[2]!)) > 1e-5 ||
      Math.abs(Vector3.Dot(axes[1]!, axes[2]!)) > 1e-5) {
    throw new Error("Furniture editing requires a rigid metre-based canonical-to-scene transform.");
  }
}

/** Babylon multiplication applies the left operand first (the equivalent of C D C^-1 in column notation). */
export function furnitureSceneDelta(canonicalToScene: Matrix, original: FurnitureWorldPose, current: FurnitureWorldPose): Matrix {
  validateFrame(canonicalToScene);
  return canonicalToScene.clone().invert().multiply(poseMatrix(original).invert())
    .multiply(poseMatrix(current)).multiply(canonicalToScene);
}

export class FurnitureGizmoBridge {
  private readonly baseWorld = new Map<AbstractMesh, Matrix>();
  private active: FurnitureEditSession | undefined;
  private manager: GizmoManager | undefined;
  constructor(private readonly scene: Scene, private readonly canonicalToScene: Matrix,
    private readonly meshesForId: (id: string) => AbstractMesh[]) {}

  apply(placement: FurniturePlacement): void {
    const delta = furnitureSceneDelta(this.canonicalToScene, placement.original, placement.current);
    this.applyDelta(placement.canonicalId, delta);
  }

  applyMatrix(placement: ScenePlacement): void {
    validateFrame(this.canonicalToScene);
    if (placement.matrix.length !== 16 || !placement.matrix.every(Number.isFinite)) throw new Error("Invalid scene placement matrix.");
    const canonicalDelta = Matrix.FromArray(placement.matrix);
    if (Math.abs(canonicalDelta.determinant()) < 1e-12) throw new Error("Invalid scene placement matrix.");
    const delta = this.canonicalToScene.clone().invert().multiply(canonicalDelta).multiply(this.canonicalToScene);
    this.applyDelta(placement.canonicalId, delta);
  }

  private applyDelta(canonicalId: string, delta: Matrix): void {
    const meshes = this.meshesForId(canonicalId);
    if (!meshes.length) throw new Error(`No render parts for ${canonicalId}.`);
    // Capture every baseline before applying any transforms; parents are handled first.
    for (const mesh of meshes) {
      mesh.computeWorldMatrix(true);
      if (!this.baseWorld.has(mesh)) this.baseWorld.set(mesh, mesh.getWorldMatrix().clone());
    }
    const depth = (mesh: AbstractMesh) => { let n = 0; for (let p = mesh.parent; p; p = p.parent) n++; return n; };
    for (const mesh of [...meshes].sort((a, b) => depth(a) - depth(b))) {
      const world = this.baseWorld.get(mesh)!.multiply(delta);
      const local = mesh.parent ? world.multiply(mesh.parent.getWorldMatrix().clone().invert()) : world;
      const scale = new Vector3(), rotation = new Quaternion(), position = new Vector3();
      if (!local.decompose(scale, rotation, position)) throw new Error("Cannot project furniture placement to this mesh.");
      mesh.position.copyFrom(position); mesh.scaling.copyFrom(scale);
      mesh.rotationQuaternion ??= new Quaternion(); mesh.rotationQuaternion.copyFrom(rotation);
      mesh.computeWorldMatrix(true);
    }
  }

  begin(placement: FurniturePlacement, onPreview: (pose: FurnitureWorldPose) => void,
    onDragState?: (dragging: boolean) => void): FurnitureEditSession {
    this.active?.cancel();
    const up = Vector3.TransformNormal(new Vector3(0, 0, 1), this.canonicalToScene).normalize();
    if (Math.abs(up.x) > 1e-5 || Math.abs(up.z) > 1e-5 || Math.abs(Math.abs(up.y) - 1) > 1e-5) {
      throw new Error("Furniture rotation requires the IFC up axis to map to scene Y.");
    }
    this.apply(placement);
    const proxy = new TransformNode("teldra-furniture-gizmo-proxy", this.scene);
    proxy.position.copyFrom(Vector3.TransformCoordinates(Vector3.FromArray(placement.current.position), this.canonicalToScene));
    proxy.rotationQuaternion = Quaternion.RotationAxis(up, placement.current.yawRadians);
    const manager = new GizmoManager(this.scene);
    this.manager = manager;
    manager.usePointerToAttachGizmos = false;
    manager.coordinatesMode = GizmoCoordinatesMode.World;
    manager.positionGizmoEnabled = true; manager.rotationGizmoEnabled = true;
    const position = manager.gizmos.positionGizmo!, rotation = manager.gizmos.rotationGizmo!;
    rotation.xGizmo.isEnabled = false; rotation.zGizmo.isEnabled = false;
    manager.attachToNode(proxy);
    let last = "";
    const emit = () => {
      const point = Vector3.TransformCoordinates(proxy.position, this.canonicalToScene.clone().invert());
      const xScene = Vector3.TransformNormal(new Vector3(1, 0, 0), this.canonicalToScene);
      const rotationMatrix = Matrix.Identity();
      proxy.rotationQuaternion!.toRotationMatrix(rotationMatrix);
      const rotated = Vector3.TransformNormal(xScene, rotationMatrix);
      const xCanonical = Vector3.TransformNormal(rotated, this.canonicalToScene.clone().invert());
      const pose: FurnitureWorldPose = {position: [point.x, point.y, point.z], yawRadians: Math.atan2(xCanonical.y, xCanonical.x)};
      const key = JSON.stringify(pose);
      if (key === last) return;
      last = key; this.apply({...placement, current: pose}); onPreview(pose);
    };
    position.onDragObservable.add(emit); rotation.onDragObservable.add(emit);
    position.onDragStartObservable.add(() => onDragState?.(true));
    rotation.onDragStartObservable.add(() => onDragState?.(true));
    position.onDragEndObservable.add(() => { emit(); onDragState?.(false); });
    rotation.onDragEndObservable.add(() => { emit(); onDragState?.(false); });
    let ended = false;
    const detach = () => { if (ended) return; ended = true; manager.dispose(); proxy.dispose(); this.manager = undefined; if (this.active === session) this.active = undefined; };
    const session: FurnitureEditSession = {
      setPose: pose => {
        poseMatrix(pose); // Validate before changing proxy or scene.
        this.apply({...placement, current: pose});
        proxy.position.copyFrom(Vector3.TransformCoordinates(Vector3.FromArray(pose.position), this.canonicalToScene));
        proxy.rotationQuaternion!.copyFrom(Quaternion.RotationAxis(up, pose.yawRadians));
        last = JSON.stringify(pose);
      },
      setMode(mode) { manager.positionGizmoEnabled = mode === "translate"; manager.rotationGizmoEnabled = mode === "rotate"; },
      setAxisConstraint(axis) {
        const gizmos = [position.xGizmo, position.yGizmo, position.zGizmo];
        if (axis === null) {
          for (const gizmo of gizmos) gizmo.isEnabled = true;
          return true;
        }
        const unit = axis === "x" ? Vector3.Right() : axis === "y" ? Vector3.Up() : Vector3.Forward();
        const mapped = Vector3.TransformNormal(unit, this.canonicalToScene).normalize();
        const components = [Math.abs(mapped.x), Math.abs(mapped.y), Math.abs(mapped.z)];
        const target = components.indexOf(Math.max(...components));
        // An arbitrary rotated frame cannot be represented by axis-aligned
        // Babylon handles; leave the full gizmo rather than mislabel an axis.
        if (components[target]! < 1 - 1e-5) return false;
        for (let i = 0; i < gizmos.length; i++) gizmos[i]!.isEnabled = i === target;
        return true;
      },
      setSnap(translation, angle) {
        if (![translation, angle].every(value => Number.isFinite(value) && value >= 0)) throw new Error("Invalid gizmo snap.");
        position.snapDistance = translation; rotation.snapDistance = angle;
      },
      cancel: () => { this.apply(placement); detach(); }, detach,
    };
    session.setMode("translate"); this.active = session;
    return session;
  }
  isInteracting(): boolean { return this.manager?.isHovered === true || this.manager?.isDragging === true; }
  dispose(): void { this.active?.cancel(); this.baseWorld.clear(); }
}
