import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Material } from "@babylonjs/core/Materials/material";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

export interface FurnitureMeasuredBounds {
  /** True source-triangle bounds, expressed in the object's original IFC local XYZ metres. */
  readonly minimum: readonly [number, number, number];
  readonly maximum: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly triangles: number;
  readonly meshParts: number;
}

/**
 * Measures actual indexed triangle geometry rather than an SH3D nominal-size
 * property or a world-aligned Babylon bounding box. Meshes are measured using
 * their saved *source* world matrices, so persisted edits/previews never
 * compound the original extents. Batched physical meshes are supported.
 *
 * Rejects animated/deformable geometry and nontriangle parts: we must never
 * silently advertise incomplete "measured" dimensions as authoritative.
 */
export function measureFurnitureTriangleBounds(
  meshes: readonly AbstractMesh[], canonicalToScene: Matrix,
  original: {readonly position: readonly [number,number,number];readonly yawRadians:number},
  originalWorld: ReadonlyMap<AbstractMesh, Matrix> = new Map(),
): FurnitureMeasuredBounds {
  if (!meshes.length || ![...original.position,original.yawRadians].every(Number.isFinite))
    throw new Error("Furniture geometry measurement requires a valid IFC source pose and mesh parts.");
  const sourcePose = Matrix.RotationZ(original.yawRadians)
    .multiply(Matrix.Translation(...original.position));
  const sceneToLocal = canonicalToScene.clone().invert().multiply(sourcePose.invert());
  const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
  let triangles = 0;
  for (const mesh of meshes) {
    if (!(mesh instanceof Mesh) || mesh.getClassName() !== "Mesh" ||
        mesh.skeleton || mesh.morphTargetManager || mesh.animations.length ||
        mesh.instances.length || mesh.hasThinInstances || mesh.infiniteDistance ||
        mesh.billboardMode || mesh.material?.fillMode !== Material.TriangleFillMode) {
      throw new Error("Measured furniture bounds require static, indexed triangle mesh parts.");
    }
    for (let p = mesh.parent; p; p = p.parent)
      if (p.animations.length) throw new Error("Animated furniture parents require evaluated geometry bounds.");
    const vertices = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    if (!vertices || !indices || indices.length === 0 || indices.length%3 !== 0 ||
        vertices.length%3 !== 0 || vertices.length === 0)
      throw new Error("Furniture triangle position/index buffers are incomplete.");
    const world = originalWorld.get(mesh) ?? mesh.computeWorldMatrix(true);
    const local = world.multiply(sceneToLocal);
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index*3+2 >= vertices.length)
        throw new Error("Invalid indexed furniture triangle geometry.");
      const point = Vector3.TransformCoordinates(
        new Vector3(vertices[index*3]!, vertices[index*3+1]!, vertices[index*3+2]!), local,
      );
      const coordinates = [point.x,point.y,point.z];
      if (!coordinates.every(Number.isFinite))
        throw new Error("Nonfinite furniture mesh vertex coordinates.");
      for (let axis=0; axis<3; axis++) {
        min[axis] = Math.min(min[axis]!,coordinates[axis]!);
        max[axis] = Math.max(max[axis]!,coordinates[axis]!);
      }
    }
    triangles += indices.length/3;
  }
  const size = min.map((value,i)=>max[i]!-value);
  if (size.some(value=>!Number.isFinite(value) || value<=1e-9 || value>1000))
    throw new Error("Furniture triangle extents must be positive and finite in all three IFC local axes.");
  return {
    minimum:min as [number,number,number],
    maximum:max as [number,number,number],
    size:size as [number,number,number],
    triangles,meshParts:meshes.length,
  };
}
