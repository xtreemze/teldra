import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TwinRenderIdentity } from "./identity.js";

export interface BatchPart { mesh: Mesh; identity: TwinRenderIdentity }
export interface MeshBatch {
  mesh: Mesh;
  parts: readonly BatchPart[];
  identityForFace(faceId: number): TwinRenderIdentity | null;
}

/** Merge only prevalidated, identically rendered triangle meshes. Source meshes remain intact. */
export function createMeshBatch(parts: readonly BatchPart[]): MeshBatch | null {
  if (parts.length < 2) return null;
  const first = parts[0]!.mesh;
  const kinds = [...first.getVerticesDataKinds()].sort().join("|");
  for (const {mesh} of parts) {
    if (mesh.material !== first.material || mesh.sideOrientation !== first.sideOrientation ||
        mesh.layerMask !== first.layerMask || mesh.renderingGroupId !== first.renderingGroupId ||
        mesh.receiveShadows !== first.receiveShadows || mesh.visibility !== first.visibility ||
        [...mesh.getVerticesDataKinds()].sort().join("|") !== kinds ||
        mesh.getTotalIndices() === 0 || mesh.getTotalIndices() % 3 !== 0 ||
        mesh.computeWorldMatrix(true).determinant() <= 0) return null;
  }
  const ranges: {end: number; identity: TwinRenderIdentity}[] = [];
  let faces = 0;
  for (const part of parts) { faces += part.mesh.getTotalIndices() / 3; ranges.push({end: faces, identity: part.identity}); }
  const merged = Mesh.MergeMeshes(parts.map(part => part.mesh), false, true, undefined, false, false);
  if (!merged) return null;
  merged.name = `teldra-batch:${first.name}`;
  merged.isPickable = true;
  return {mesh: merged, parts, identityForFace(faceId) {
    if (!Number.isInteger(faceId) || faceId < 0) return null;
    return ranges.find(range => faceId < range.end)?.identity ?? null;
  }};
}
