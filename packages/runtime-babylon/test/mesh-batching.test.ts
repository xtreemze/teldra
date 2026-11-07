import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { createMeshBatch } from "../src/mesh-batching";
import { SceneLayers } from "../src/view-controls";
import { FurnitureGizmoBridge } from "../src/furniture-gizmo";
import { Matrix } from "@babylonjs/core/Maths/math.vector";

describe("mesh batching", () => {
  it("preserves the source meshes, triangle identities, material and vertex attributes", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const material = new StandardMaterial("material", scene);
      const first = CreateBox("first", {}, scene), second = CreateBox("second", {}, scene);
      first.material = second.material = material; second.position.x = 2;
      const a = {nodeKey: "a", canonicalId: "chair", kind: "building" as const};
      const b = {nodeKey: "b", canonicalId: "chair", kind: "building" as const};
      const batch = createMeshBatch([{mesh: first, identity: a}, {mesh: second, identity: b}])!;
      expect(batch.mesh.material).toBe(material);
      expect(batch.mesh.getTotalVertices()).toBe(first.getTotalVertices() + second.getTotalVertices());
      expect(batch.mesh.getVerticesDataKinds().sort()).toEqual(first.getVerticesDataKinds().sort());
      expect(batch.mesh.getVerticesData("uv")?.slice(0, first.getVerticesData("uv")!.length)).toEqual(first.getVerticesData("uv"));
      expect(batch.mesh.getVerticesData("normal")?.slice(0, first.getVerticesData("normal")!.length)).toEqual(first.getVerticesData("normal"));
      expect(batch.identityForFace(0)).toBe(a);
      expect(batch.identityForFace(first.getTotalIndices() / 3)).toBe(b);
      expect(batch.identityForFace(batch.mesh.getTotalIndices() / 3)).toBeNull();
      expect(first.isDisposed()).toBe(false); expect(second.isDisposed()).toBe(false);
      const layers = new SceneLayers();
      layers.add(first, "sh3d:wall:a", false); layers.add(second, "sh3d:wall:a", false);
      layers.addBatch(batch.mesh, [first, second]);
      const pickA = scene.pickWithRay(new Ray(new Vector3(0, 0, -5), Vector3.Forward()), mesh => mesh === batch.mesh);
      const pickB = scene.pickWithRay(new Ray(new Vector3(2, 0, -5), Vector3.Forward()), mesh => mesh === batch.mesh);
      expect(batch.identityForFace(pickA?.faceId ?? -1)).toBe(a);
      expect(batch.identityForFace(pickB?.faceId ?? -1)).toBe(b);
      expect(first.isEnabled()).toBe(false); expect(second.isEnabled()).toBe(false);
      expect(batch.mesh.isEnabled()).toBe(true); expect(layers.isVisible(first)).toBe(true);
      layers.setVisible("category:Walls", false); expect(batch.mesh.isEnabled()).toBe(false);
      layers.setVisible("category:Walls", true); expect(batch.mesh.isEnabled()).toBe(true);
      expect(first.isEnabled()).toBe(false); expect(layers.list()[0]?.meshParts).toBe(2);
      const bridge = new FurnitureGizmoBridge(scene, Matrix.Identity(), () => [batch.mesh]);
      const original = {position: [0, 0, 0] as const, yawRadians: 0};
      const measured = bridge.measureSourceGeometry("chair",original);
      expect(measured.meshParts).toBe(1);
      expect(measured.triangles).toBe(24);
      expect(measured.size).toEqual([3,1,1]);
      bridge.apply({canonicalId: "chair", original, current: {position: [0, 3, 0], yawRadians: 0}});
      expect(bridge.measureSourceGeometry("chair",original)).toEqual(measured);
      const moved = scene.pickWithRay(new Ray(new Vector3(2, 3, -5), Vector3.Forward()), mesh => mesh === batch.mesh);
      expect(batch.identityForFace(moved?.faceId ?? -1)).toBe(b);
      bridge.apply({canonicalId: "chair", original, current: original});
      bridge.dispose();
    } finally { scene.dispose(); engine.dispose(); }
  });
});
