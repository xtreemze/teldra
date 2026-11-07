import { GizmoManager } from "@babylonjs/core/Gizmos/gizmoManager";
import { GizmoCoordinatesMode } from "@babylonjs/core/Gizmos/gizmo";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Node } from "@babylonjs/core/node";
import { factorUprightFurnitureMatrix } from "./affine-furniture.js";
import { measureFurnitureTriangleBounds, type FurnitureMeasuredBounds } from "./furniture-bounds.js";

/** IFC world metres, right-handed Z-up. This is an edit draft, not canonical state. */
export interface FurnitureWorldPose { position: readonly [number, number, number]; yawRadians: number }
export type GeometryScale = readonly [number, number, number];
export interface FurniturePlacement {
  canonicalId: string;
  original: FurnitureWorldPose;
  current: FurnitureWorldPose;
  /** Source GLB geometry scale as represented in the source IFC mapping target. */
  sourceScale?: GeometryScale | undefined;
  /** Current canonical IFC mapped-geometry scale. */
  currentScale?: GeometryScale | undefined;
}
export interface ScenePlacement { canonicalId: string; matrix: readonly number[] }
export interface FurnitureEditSession {
  setPose(pose: FurnitureWorldPose): void;
  setMode(mode: "translate" | "rotate" | "scale"): void;
  setScale(scale: GeometryScale): void;
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

/** Babylon scaling is local; the IFC Z-up axes must be mapped explicitly. */
function axisMapping(frame: Matrix): [number, number, number] {
  const basis = [Vector3.Right(), Vector3.Up(), Vector3.Forward()];
  const result = basis.map(axis => {
    const transformed = Vector3.TransformNormal(axis, frame).normalize().asArray();
    const abs = transformed.map(Math.abs);
    const index = abs.indexOf(Math.max(...abs));
    if (abs[index]! < 1 - 1e-5) throw new Error("IFC scale gizmo requires axis-aligned scene coordinates.");
    return index;
  });
  if (new Set(result).size !== 3) throw new Error("Invalid IFC scale axis mapping.");
  return result as [number, number, number];
}

/** Babylon multiplication applies the left operand first (the equivalent of C D C^-1 in column notation). */
export function furnitureSceneDelta(canonicalToScene: Matrix, original: FurnitureWorldPose,
  current: FurnitureWorldPose, ratio: GeometryScale = [1, 1, 1]): Matrix {
  validateFrame(canonicalToScene);
  poseMatrix(original); poseMatrix(current);
  if (ratio.length !== 3 || ratio.some(value => !Number.isFinite(value) || value <= 0 || value > 1000))
    throw new Error("Invalid IFC geometry scale factors.");
  const cs = Math.cos(original.yawRadians), ss = Math.sin(original.yawRadians);
  const cc = Math.cos(current.yawRadians), sc = Math.sin(current.yawRadians);
  const [sx, sy, sz] = ratio;
  const a00 = cc*sx*cs + sc*sy*ss, a01 = cc*sx*ss - sc*sy*cs;
  const a10 = sc*sx*cs - cc*sy*ss, a11 = sc*sx*ss + cc*sy*cs;
  const canonicalDelta = Matrix.FromArray([a00,a10,0,0,a01,a11,0,0,0,0,sz,0,
    current.position[0]-a00*original.position[0]-a01*original.position[1],
    current.position[1]-a10*original.position[0]-a11*original.position[1],
    current.position[2]-sz*original.position[2],1]);
  return canonicalToScene.clone().invert().multiply(canonicalDelta).multiply(canonicalToScene);
}

export class FurnitureGizmoBridge {
  private readonly baseWorld = new Map<AbstractMesh, Matrix>();
  private readonly sourceMeasurements = new Map<string, FurnitureMeasuredBounds>();
  private readonly affineGroups = new Map<string, {
    root: TransformNode; pre: TransformNode;
    parentByMesh: Map<AbstractMesh, Node | null>;
  }>();
  private active: FurnitureEditSession | undefined;
  private manager: GizmoManager | undefined;
  constructor(private readonly scene: Scene, private readonly canonicalToScene: Matrix,
    private readonly meshesForId: (id: string) => AbstractMesh[]) {}

  measureSourceGeometry(canonicalId: string, original: FurnitureWorldPose): FurnitureMeasuredBounds {
    const cached = this.sourceMeasurements.get(canonicalId);
    if (cached) return cached;
    validateFrame(this.canonicalToScene);
    const parts = this.meshesForId(canonicalId);
    const measured = measureFurnitureTriangleBounds(parts, this.canonicalToScene, original, this.baseWorld);
    this.sourceMeasurements.set(canonicalId, measured);
    return measured;
  }

  apply(placement: FurniturePlacement): void {
    const ratio: GeometryScale = placement.sourceScale && placement.currentScale
      ? placement.currentScale.map((v, i) => v / placement.sourceScale![i]!) as [number,number,number]
      : [1,1,1];
    const delta = furnitureSceneDelta(this.canonicalToScene, placement.original, placement.current, ratio);
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
    const existing = this.affineGroups.get(canonicalId);
    if (existing) { this.applyAffineGroup(existing, delta); return; }
    const meshes = this.meshesForId(canonicalId);
    if (!meshes.length) throw new Error(`No render parts for ${canonicalId}.`);
    // Capture every baseline before applying any transforms; parents are handled first.
    for (const mesh of meshes) {
      mesh.computeWorldMatrix(true);
      if (!this.baseWorld.has(mesh)) this.baseWorld.set(mesh, mesh.getWorldMatrix().clone());
    }
    const depth = (mesh: AbstractMesh) => { let n = 0; for (let p = mesh.parent; p; p = p.parent) n++; return n; };
    const projectedWorld = new Map<AbstractMesh, Matrix>();
    const plans: {mesh: AbstractMesh; position: Vector3; scale: Vector3; rotation: Quaternion}[] = [];
    let needsAffineHierarchy = false;
    for (const mesh of [...meshes].sort((a, b) => depth(a) - depth(b))) {
      const world = this.baseWorld.get(mesh)!.multiply(delta);
      const parent = mesh.parent;
      const projectedParent = parent instanceof TransformNode || (parent && "getWorldMatrix" in parent)
        ? (projectedWorld.get(parent as AbstractMesh) ?? parent.getWorldMatrix()).clone() : null;
      const local = projectedParent ? world.multiply(projectedParent.invert()) : world;
      const scale = new Vector3(), rotation = new Quaternion(), position = new Vector3();
      if (!local.decompose(scale, rotation, position)) throw new Error("Cannot project furniture placement to this mesh.");
      const reconstructed = Matrix.Compose(scale, rotation, position);
      if (local.asArray().some((value, i) => Math.abs(value - reconstructed.asArray()[i]!) > 1e-4)) {
        needsAffineHierarchy = true;
        break;
      }
      projectedWorld.set(mesh, world);
      plans.push({mesh, position, scale, rotation});
    }
    if (needsAffineHierarchy) {
      // A valid IFC affine edit can shear the mesh's world matrix without
      // requiring any shear in its *local* TRS. A two-node SVD hierarchy
      // represents it exactly and preserves original geometry buffers.
      const factors = this.affineFactors(delta); // Must validate before scene changes.
      this.applyDelta(canonicalId, Matrix.Identity()); // Restore original world poses first.
      const group = this.createAffineGroup(canonicalId, meshes);
      try { this.setAffineFactors(group, factors); }
      catch (error) { this.dropAffineGroup(canonicalId, group); throw error; }
      return;
    }
    // Validate all part transforms first; a rejected scale must never leave
    // half the furniture moved or scaled in the render graph.
    for (const {mesh, position, scale, rotation} of plans) {
      mesh.position.copyFrom(position); mesh.scaling.copyFrom(scale);
      mesh.rotationQuaternion ??= new Quaternion(); mesh.rotationQuaternion.copyFrom(rotation);
      mesh.computeWorldMatrix(true);
    }
  }


  private affineFactors(delta: Matrix) {
    const frame = this.canonicalToScene;
    const canonicalDelta = frame.multiply(delta).multiply(frame.clone().invert());
    return factorUprightFurnitureMatrix(canonicalDelta.asArray());
  }

  private static componentMatrix(node: TransformNode, m: Matrix): void {
    const scale = new Vector3(), rotation = new Quaternion(), position = new Vector3();
    if (!m.decompose(scale, rotation, position)) throw new Error("Cannot project IFC affine factors to Babylon.");
    const reconstructed = Matrix.Compose(scale, rotation, position);
    if (m.asArray().some((value, i) => Math.abs(value - reconstructed.asArray()[i]!) > 1e-5))
      throw new Error("IFC affine factor is not an exact Babylon TRS.");
    node.position.copyFrom(position);
    node.rotationQuaternion ??= new Quaternion();
    node.rotationQuaternion.copyFrom(rotation);
    node.scaling.copyFrom(scale);
    node.computeWorldMatrix(true);
  }

  private setAffineFactors(
    group: {root: TransformNode;pre: TransformNode}, factors: ReturnType<typeof factorUprightFurnitureMatrix>,
  ): void {
    const frame = this.canonicalToScene;
    const inv = frame.clone().invert();
    const parentScene = inv.multiply(factors.root).multiply(frame);
    const preScene = inv.multiply(factors.preRotation).multiply(frame);
    // Both matrices were validated before modifying the scene.
    FurnitureGizmoBridge.componentMatrix(group.pre, preScene);
    FurnitureGizmoBridge.componentMatrix(group.root, parentScene);
  }

  private applyAffineGroup(group: {root: TransformNode;pre: TransformNode}, delta: Matrix): void {
    this.setAffineFactors(group, this.affineFactors(delta));
  }

  /**
   * Pure preflight for an IFC command. A viewer that cannot project the source
   * mesh's exact affine transform may never authorize the canonical scale edit.
   */
  assertAffineProjectable(canonicalId: string, canonicalDelta: readonly number[]): void {
    factorUprightFurnitureMatrix(canonicalDelta);
    const meshes=this.meshesForId(canonicalId);
    if(!meshes.length) throw new Error("This furniture has no physical render geometry.");
    if(this.affineGroups.has(canonicalId)) return;
    this.assertStaticAffineMeshes(meshes);
    for(const mesh of meshes) {
      const source=this.baseWorld.get(mesh)??mesh.computeWorldMatrix(true);
      if(source.determinant()<=1e-9)
        throw new Error("Mirrored or singular source GLB geometry requires regeneration.");
      const s=new Vector3(),r=new Quaternion(),p=new Vector3();
      if(!source.decompose(s,r,p)) throw new Error("Source GLB mesh hierarchy requires vertex regeneration.");
      const reconstructed=Matrix.Compose(s,r,p).asArray();
      if(source.asArray().some((v,i)=>Math.abs(v-reconstructed[i]!)>1e-5*Math.max(1,Math.abs(v))))
        throw new Error("Source GLB contains non-TRS mesh hierarchy; regeneration required.");
    }
  }
  private assertStaticAffineMeshes(meshes: readonly AbstractMesh[]): void {
    const selected=new Set(meshes);
    for(const mesh of meshes) {
      if(!(mesh instanceof Mesh) || mesh.getClassName()!=="Mesh" ||
          mesh.skeleton || mesh.morphTargetManager || mesh.animations.length ||
          mesh.instances.length || mesh.hasThinInstances || mesh.billboardMode ||
          mesh.infiniteDistance)
        throw new Error("Animated, skinned or instanced geometry requires source GLB regeneration.");
      for(let parent=mesh.parent; parent; parent=parent.parent)
        if(parent.animations.length) throw new Error("Animated parent requires source GLB regeneration.");
      if(mesh.getChildMeshes(false).some(child=>child.getTotalVertices()>0&&!selected.has(child)))
        throw new Error("Mixed-identity geometry hierarchy requires source GLB regeneration.");
    }
  }

  private createAffineGroup(canonicalId: string, meshes: readonly AbstractMesh[]) {
    const parents = new Map<AbstractMesh, Node | null>();
    const selected = new Set(meshes);
    const roots = meshes.filter(mesh => {
      for (let parent = mesh.parent; parent; parent = parent.parent)
        if (selected.has(parent as AbstractMesh)) return false;
      return true;
    });
    this.assertStaticAffineMeshes(meshes);
    for (const mesh of meshes) {
      if (this.baseWorld.get(mesh)!.determinant() <= 1e-9)
        throw new Error("Mirrored or singular source GLB geometry requires regeneration.");
    }
    const root = new TransformNode("teldra-affine-root:" + canonicalId, this.scene);
    const pre = new TransformNode("teldra-affine-prerotation:" + canonicalId, this.scene);
    pre.parent = root;
    try {
      for (const mesh of roots) {
        parents.set(mesh, mesh.parent);
        mesh.setParent(pre); // Preserves original GLB world transform.
      }
      for (const mesh of meshes) {
        const original = this.baseWorld.get(mesh)!;
        const current = mesh.computeWorldMatrix(true).asArray();
        if (current.some((value, i) =>
          Math.abs(value - original.asArray()[i]!) > 1e-5*Math.max(1,Math.abs(value),Math.abs(original.asArray()[i]!))))
          throw new Error("GLB parent hierarchy cannot be preserved without vertex regeneration.");
      }
    } catch (error) {
      for (const [mesh, parent] of parents) mesh.setParent(parent);
      pre.dispose(true); root.dispose(true);
      throw error;
    }
    const group = {root,pre,parentByMesh:parents};
    this.affineGroups.set(canonicalId,group);
    return group;
  }

  private dropAffineGroup(canonicalId: string, group: {
    root: TransformNode;pre: TransformNode;parentByMesh: Map<AbstractMesh, Node | null>;
  }): void {
    this.applyAffineGroup(group, Matrix.Identity());
    for (const [mesh,parent] of group.parentByMesh) mesh.setParent(parent);
    group.pre.dispose(true); group.root.dispose(true);
    this.affineGroups.delete(canonicalId);
  }

  begin(placement: FurniturePlacement, onPreview: (pose: FurnitureWorldPose) => void,
    onDragState?: (dragging: boolean) => void,
    onScalePreview?: (scale: GeometryScale) => void): FurnitureEditSession {
    this.active?.cancel();
    const up = Vector3.TransformNormal(new Vector3(0, 0, 1), this.canonicalToScene).normalize();
    if (Math.abs(up.x) > 1e-5 || Math.abs(up.z) > 1e-5 || Math.abs(Math.abs(up.y) - 1) > 1e-5) {
      throw new Error("Furniture rotation requires the IFC up axis to map to scene Y.");
    }
    this.apply(placement);
    const scalesSupported = placement.sourceScale !== undefined && placement.currentScale !== undefined;
    const mapping = scalesSupported ? axisMapping(this.canonicalToScene) : [0,1,2];
    let draftPose = placement.current;
    let draftScale: GeometryScale = placement.currentScale ?? [1,1,1];
    const toSceneScale = (scale: GeometryScale) => {
      const values = [1,1,1];
      for (let i = 0; i < 3; i++) values[mapping[i]!] = scale[i]!;
      return new Vector3(values[0]!,values[1]!,values[2]!);
    };
    const fromSceneScale = (v: Vector3): GeometryScale =>
      [v.asArray()[mapping[0]!]!, v.asArray()[mapping[1]!]!, v.asArray()[mapping[2]!]!];
    const proxy = new TransformNode("teldra-furniture-gizmo-proxy", this.scene);
    proxy.position.copyFrom(Vector3.TransformCoordinates(Vector3.FromArray(placement.current.position), this.canonicalToScene));
    proxy.rotationQuaternion = Quaternion.RotationAxis(up, placement.current.yawRadians);
    proxy.scaling.copyFrom(toSceneScale(draftScale));
    const manager = new GizmoManager(this.scene);
    this.manager = manager;
    manager.usePointerToAttachGizmos = false;
    manager.coordinatesMode = GizmoCoordinatesMode.World;
    manager.positionGizmoEnabled = true; manager.rotationGizmoEnabled = true;
    if (scalesSupported) manager.scaleGizmoEnabled = true;
    const position = manager.gizmos.positionGizmo!, rotation = manager.gizmos.rotationGizmo!;
    const scaleGizmo = manager.gizmos.scaleGizmo;
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
      last = key; draftPose = pose;
      this.apply({...placement, current: draftPose, currentScale: scalesSupported ? draftScale : undefined});
      onPreview(pose);
    };
    const emitScale = () => {
      if (!scalesSupported) return;
      const next = fromSceneScale(proxy.scaling);
      if (next.some(value => !Number.isFinite(value) || value <= 0 || value > 1000)) {
        proxy.scaling.copyFrom(toSceneScale(draftScale)); return;
      }
      try {
        this.apply({...placement, current: draftPose, currentScale: next});
        draftScale = next; onScalePreview?.(next);
      } catch {
        proxy.scaling.copyFrom(toSceneScale(draftScale));
      }
    };
    position.onDragObservable.add(emit); rotation.onDragObservable.add(emit);
    scaleGizmo?.onDragObservable.add(emitScale);
    scaleGizmo?.onDragStartObservable.add(() => onDragState?.(true));
    scaleGizmo?.onDragEndObservable.add(() => { emitScale(); onDragState?.(false); });
    position.onDragStartObservable.add(() => onDragState?.(true));
    rotation.onDragStartObservable.add(() => onDragState?.(true));
    position.onDragEndObservable.add(() => { emit(); onDragState?.(false); });
    rotation.onDragEndObservable.add(() => { emit(); onDragState?.(false); });
    let ended = false;
    const detach = () => { if (ended) return; ended = true; manager.dispose(); proxy.dispose(); this.manager = undefined; if (this.active === session) this.active = undefined; };
    const session: FurnitureEditSession = {
      setPose: pose => {
        poseMatrix(pose); // Validate before changing proxy or scene.
        this.apply({...placement, current: pose, currentScale: scalesSupported ? draftScale : undefined});
        draftPose = pose;
        proxy.position.copyFrom(Vector3.TransformCoordinates(Vector3.FromArray(pose.position), this.canonicalToScene));
        proxy.rotationQuaternion!.copyFrom(Quaternion.RotationAxis(up, pose.yawRadians));
        last = JSON.stringify(pose);
      },
      setScale: scale => {
        if (!scalesSupported || scale.length !== 3 ||
            scale.some(value => !Number.isFinite(value) || value <= 0 || value > 1000))
          throw new Error("Mapped IFC geometry scaling is not supported for this furniture.");
        this.apply({...placement, current: draftPose, currentScale: scale});
        draftScale = scale;
        proxy.scaling.copyFrom(toSceneScale(scale));
      },
      setMode(mode) {
        if (mode === "scale" && !scalesSupported) throw new Error("This furniture has no supported IFC mapped geometry.");
        manager.coordinatesMode = mode === "scale" ? GizmoCoordinatesMode.Local : GizmoCoordinatesMode.World;
        manager.positionGizmoEnabled = mode === "translate";
        manager.rotationGizmoEnabled = mode === "rotate";
        manager.scaleGizmoEnabled = mode === "scale";
      },
      setAxisConstraint: (axis) => {
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
  dispose(): void {
    this.active?.cancel();
    for (const [id, group] of this.affineGroups) this.dropAffineGroup(id, group);
    this.baseWorld.clear();
    this.sourceMeasurements.clear();
  }
}
