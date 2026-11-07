import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { FurnitureGizmoBridge, furnitureSceneDelta } from "../src/furniture-gizmo";

const C = Matrix.FromArray([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
const original = {position: [1, -1, 0] as const, yawRadians: 0};
const current = {position: [2, 3, 1] as const, yawRadians: Math.PI / 2};

describe("IFC furniture projection", () => {
  it("conjugates the world placement delta into scene coordinates", () => {
    const source = Vector3.TransformCoordinates(Vector3.FromArray(original.position), C);
    const moved = Vector3.TransformCoordinates(source, furnitureSceneDelta(C, original, current));
    const expected = Vector3.TransformCoordinates(Vector3.FromArray(current.position), C);
    expect(moved.asArray()).toEqual(expected.asArray().map(value => expect.closeTo(value, 5)));
    const x = Vector3.TransformCoordinates(Vector3.TransformCoordinates(new Vector3(2, -1, 0), C), furnitureSceneDelta(C, original, current));
    const expectedX = Vector3.TransformCoordinates(new Vector3(2, 4, 1), C);
    expect(x.asArray()).toEqual(expectedX.asArray().map(value => expect.closeTo(value, 5)));
  });
  it("reapplies from original render transforms and restores them", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const mesh = CreateBox("furniture", {}, scene);
      mesh.position.copyFrom(Vector3.TransformCoordinates(Vector3.FromArray(original.position), C));
      const bridge = new FurnitureGizmoBridge(scene, C, id => id === "chair" ? [mesh] : []);
      bridge.apply({canonicalId: "chair", original, current});
      const expected = Vector3.TransformCoordinates(Vector3.FromArray(current.position), C);
      expect(mesh.position.asArray()).toEqual(expected.asArray().map(value => expect.closeTo(value, 5)));
      bridge.apply({canonicalId: "chair", original, current: original});
      const restored = Vector3.TransformCoordinates(Vector3.FromArray(original.position), C);
      expect(mesh.position.asArray()).toEqual(restored.asArray().map(value => expect.closeTo(value, 5)));
      expect(() => bridge.apply({canonicalId: "missing", original, current})).toThrow();
      bridge.dispose();
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("projects persisted canonical matrices for multiple parented parts without accumulating transforms", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const parent = new TransformNode("parent", scene); parent.position.set(3, 2, 1);
      const first = CreateBox("one", {}, scene), second = CreateBox("two", {}, scene);
      first.parent = parent; second.parent = parent; second.position.x = 2;
      first.computeWorldMatrix(true); second.computeWorldMatrix(true);
      const source = [first, second].map(mesh => mesh.getAbsolutePosition().clone());
      const bridge = new FurnitureGizmoBridge(scene, C, () => [first, second]);
      const matrix = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 2, 1, 1];
      const sceneDelta = C.clone().invert().multiply(Matrix.FromArray(matrix)).multiply(C);
      bridge.applyMatrix({canonicalId: "chair", matrix});
      for (const [index, mesh] of [first, second].entries()) {
        const expected = Vector3.TransformCoordinates(source[index]!, sceneDelta);
        expect(mesh.getAbsolutePosition().asArray()).toEqual(expected.asArray().map(value => expect.closeTo(value, 5)));
      }
      bridge.applyMatrix({canonicalId: "chair", matrix: Matrix.Identity().asArray()});
      for (const [index, mesh] of [first, second].entries()) {
        expect(mesh.getAbsolutePosition().asArray()).toEqual(source[index]!.asArray().map(value => expect.closeTo(value, 5)));
      }
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("sets a manual preview without emitting a drag and cancels to the committed pose", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      new ArcRotateCamera("camera", 0, 1, 10, Vector3.Zero(), scene);
      const mesh = CreateBox("chair", {}, scene);
      mesh.position.copyFrom(Vector3.TransformCoordinates(Vector3.FromArray(original.position), C));
      const bridge = new FurnitureGizmoBridge(scene, C, () => [mesh]);
      let calls = 0;
      const session = bridge.begin({canonicalId: "chair", original, current}, () => { calls++; });
      session.setPose(original);
      expect(calls).toBe(0);
      session.cancel();
      const expected = Vector3.TransformCoordinates(Vector3.FromArray(current.position), C);
      expect(mesh.position.asArray()).toEqual(expected.asArray().map(value => expect.closeTo(value, 5)));
      bridge.dispose();
    } finally { scene.dispose(); engine.dispose(); }
  });
});
