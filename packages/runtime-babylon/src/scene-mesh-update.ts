import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import type { SceneMeshApplyResult, SceneMeshUpdate, ScenePart } from "@teldra/projection";
import type { TwinRenderIdentity } from "./identity.js";
import type { MeshBatch } from "./mesh-batching.js";
import type { SceneLayers } from "./view-controls.js";

/** Runtime registries the update mutates; arrays and maps are edited in place. */
export interface SceneMeshUpdateContext {
  readonly scene: Scene;
  readonly manifestByNodeKey: Map<string, TwinRenderIdentity>;
  readonly identityByMesh: WeakMap<AbstractMesh, TwinRenderIdentity>;
  readonly meshByNodeKey: Map<string, AbstractMesh>;
  readonly meshesByCanonicalId: Map<string, AbstractMesh[]>;
  readonly layers: SceneLayers;
  readonly renderMeshes: AbstractMesh[];
  readonly physicalMeshes: AbstractMesh[];
  readonly batchByPart: ReadonlyMap<AbstractMesh, MeshBatch>;
  readonly sourceHiddenMeshes: Set<AbstractMesh>;
}

export class SceneMeshUpdateUnsupportedError extends Error {
  constructor(message: string) { super(message); this.name = "SceneMeshUpdateUnsupportedError"; }
}

/**
 * Applies a projection-level {@link SceneMeshUpdate} to a live Babylon scene.
 *
 * Atomic: all new meshes are built and validated first (disabled, unregistered). Only if that
 * succeeds are old meshes swapped out in a registry-only commit; any failure disposes the staged
 * meshes and leaves the previous scene, registries and layers exactly as they were.
 * Materials of replaced elements are reused (never cloned or disposed), so textures/PBR
 * settings of unaffected and replaced objects survive; brand-new elements get a neutral material
 * from the IFC colour. Batched (merged) parts are not patchable and are rejected, which the
 * caller treats as "full rebuild required".
 */
export function applySceneMeshUpdate(ctx: SceneMeshUpdateContext, update: SceneMeshUpdate): SceneMeshApplyResult {
  const staged: Mesh[] = [];
  let fallbackMaterial: StandardMaterial | undefined;
  try {
    const dropped = new Map<string, AbstractMesh>(); // nodeKey -> old mesh
    const oldByGlobalId = new Map<string, AbstractMesh[]>();
    const collect = (globalId: string, nodeKeys: readonly string[]) => {
      const meshes: AbstractMesh[] = [];
      for (const key of nodeKeys) {
        const mesh = ctx.meshByNodeKey.get(key);
        if (!mesh) throw new SceneMeshUpdateUnsupportedError(`Scene has no mesh for node ${key}.`);
        if (ctx.batchByPart.has(mesh)) throw new SceneMeshUpdateUnsupportedError(`Node ${key} is part of a merged batch.`);
        if (dropped.has(key)) throw new SceneMeshUpdateUnsupportedError(`Node ${key} appears twice in the update.`);
        dropped.set(key, mesh); meshes.push(mesh);
      }
      oldByGlobalId.set(globalId, meshes);
    };
    for (const element of update.replace) collect(element.globalId, element.previousNodeKeys);
    for (const element of update.remove) collect(element.globalId, element.nodeKeys);

    const created: Array<{ mesh: Mesh; part: ScenePart; hidden: boolean }> = [];
    const newKeys = new Set<string>();
    let fallback: StandardMaterial | undefined;
    for (const element of [...update.replace, ...update.add]) {
      const olds = oldByGlobalId.get(element.globalId) ?? [];
      element.parts.forEach((part, index) => {
        const key = part.node.nodeKey;
        if (newKeys.has(key) || (ctx.meshByNodeKey.has(key) && !dropped.has(key)))
          throw new SceneMeshUpdateUnsupportedError(`Node key ${key} is already in use.`);
        newKeys.add(key);
        if (part.positions.length === 0 || part.positions.length % 3 || part.normals.length !== part.positions.length ||
            part.indices.length === 0 || part.indices.length % 3 ||
            part.indices.some((i) => i >= part.positions.length / 3))
          throw new Error(`Malformed mesh data for ${key}.`);
        const source = olds[index] ?? olds[0];
        const mesh = new Mesh(key, ctx.scene);
        staged.push(mesh);
        mesh.setEnabled(false);
        const data = new VertexData();
        data.positions = part.positions; data.normals = part.normals; data.indices = part.indices;
        data.applyToMesh(mesh);
        mesh.isPickable = true;
        if (source) {
          mesh.material = source.material;
          if (source instanceof Mesh) mesh.sideOrientation = source.sideOrientation;
          mesh.receiveShadows = source.receiveShadows;
          mesh.layerMask = source.layerMask;
        } else {
          fallback ??= fallbackMaterial = (() => {
            const material = new StandardMaterial(`teldra-regenerated:${key}`, ctx.scene);
            material.diffuseColor = new Color3(part.color[0], part.color[1], part.color[2]);
            material.alpha = part.color[3];
            material.backFaceCulling = false;
            return material;
          })();
          mesh.material = fallback;
        }
        const sourceGltf = (source?.metadata as { gltf?: { extras?: Record<string, unknown> } } | undefined)?.gltf;
        mesh.metadata = { gltf: { extras: {
          ...(sourceGltf?.extras ?? {}),
          teldra: { nodeKey: key, canonicalId: part.node.canonicalId, ifcGlobalId: element.globalId },
        } } };
        created.push({ mesh, part, hidden: source ? ctx.sourceHiddenMeshes.has(source) : false });
      });
    }
    for (const { mesh } of created) mesh.computeWorldMatrix(true);

    // Commit: registry edits only; nothing below throws on validated input.
    for (const [key, mesh] of dropped) {
      const identity = ctx.identityByMesh.get(mesh);
      ctx.layers.remove(mesh);
      ctx.manifestByNodeKey.delete(key);
      ctx.meshByNodeKey.delete(key);
      if (identity) {
        const list = (ctx.meshesByCanonicalId.get(identity.canonicalId) ?? []).filter((m) => m !== mesh);
        if (list.length) ctx.meshesByCanonicalId.set(identity.canonicalId, list); else ctx.meshesByCanonicalId.delete(identity.canonicalId);
      }
      ctx.sourceHiddenMeshes.delete(mesh);
      for (const list of [ctx.renderMeshes, ctx.physicalMeshes]) { const at = list.indexOf(mesh); if (at >= 0) list.splice(at, 1); }
      mesh.dispose(false, false);
    }
    for (const { mesh, part, hidden } of created) {
      const identity: TwinRenderIdentity = { nodeKey: part.node.nodeKey, canonicalId: part.node.canonicalId,
        ...(part.node.ifcGlobalId === undefined ? {} : { ifcGlobalId: part.node.ifcGlobalId }) };
      ctx.manifestByNodeKey.set(identity.nodeKey, identity);
      ctx.identityByMesh.set(mesh, identity);
      ctx.meshByNodeKey.set(identity.nodeKey, mesh);
      ctx.meshesByCanonicalId.set(identity.canonicalId, [...(ctx.meshesByCanonicalId.get(identity.canonicalId) ?? []), mesh]);
      if (hidden) ctx.sourceHiddenMeshes.add(mesh);
      ctx.layers.add(mesh, identity.canonicalId, hidden);
      ctx.renderMeshes.push(mesh);
      ctx.physicalMeshes.push(mesh);
    }
    return { ok: true };
  } catch (error) {
    for (const mesh of staged) mesh.dispose(false, false);
    fallbackMaterial?.dispose();
    return { ok: false, error };
  }
}
