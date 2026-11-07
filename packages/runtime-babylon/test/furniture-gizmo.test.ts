import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
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
      mesh.material = new StandardMaterial("source",scene);
      mesh.position.copyFrom(Vector3.TransformCoordinates(Vector3.FromArray(original.position), C));
      const bridge = new FurnitureGizmoBridge(scene, C, id => id === "chair" ? [mesh] : []);
      const measuredSource = bridge.measureSourceGeometry("chair",original);
      expect(measuredSource.size).toEqual([1,1,1]);
      bridge.apply({canonicalId: "chair", original, current});
      expect(bridge.measureSourceGeometry("chair",original)).toEqual(measuredSource);
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
      expect(session.setAxisConstraint("x")).toBe(true);
      expect(session.setAxisConstraint("y")).toBe(true);
      expect(session.setAxisConstraint("z")).toBe(true);
      expect(session.setAxisConstraint(null)).toBe(true);
      session.setPose(original);
      expect(calls).toBe(0);
      session.cancel();
      const expected = Vector3.TransformCoordinates(Vector3.FromArray(current.position), C);
      expect(mesh.position.asArray()).toEqual(expected.asArray().map(value => expect.closeTo(value, 5)));
      bridge.dispose();
    } finally { scene.dispose(); engine.dispose(); }
  });
});


it("projects IFC local-axis scale about the original placement, including Z-up scene mapping", () => {
  const source = {position:[1,-1,0] as const,yawRadians:0};
  const target = {position:[2,3,1] as const,yawRadians:Math.PI/2};
  const delta = furnitureSceneDelta(C,source,target,[2,1.5,0.5]);
  const originalAnchor = Vector3.TransformCoordinates(Vector3.FromArray(source.position),C);
  const projectedAnchor = Vector3.TransformCoordinates(originalAnchor,delta);
  expect(projectedAnchor.asArray()).toEqual(Vector3.TransformCoordinates(Vector3.FromArray(target.position),C).asArray().map(v=>expect.closeTo(v,5)));
  const sceneOffsetX = Vector3.TransformCoordinates(Vector3.FromArray([source.position[0]+1,source.position[1],source.position[2]]),C);
  const projectedX = Vector3.TransformCoordinates(sceneOffsetX,delta);
  const targetX = Vector3.TransformCoordinates(Vector3.FromArray([target.position[0],target.position[1]+2,target.position[2]]),C);
  expect(projectedX.asArray()).toEqual(targetX.asArray().map(v=>expect.closeTo(v,5)));
  expect(()=>furnitureSceneDelta(C,source,target,[0,1,1])).toThrow(/scale/);
});


it("projects nonuniform IFC scale through rotated source geometry using exact affine hierarchy", () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const parent = new TransformNode("source-root",scene);
    parent.position.set(3,0,-1);
    const one = CreateBox("one", {}, scene), two = CreateBox("two", {}, scene);
    one.parent = parent; two.parent = parent;
    one.position.x = 0.3;
    two.position.z = 2;
    two.rotation.y = Math.PI/7;
    const bridge = new FurnitureGizmoBridge(scene,C,()=>[one,two]);
    const source = {position:[0,0,0] as const,yawRadians:Math.PI/4};
    const current = {position:[2,1,0] as const,yawRadians:0};
    const before = [one,two].map(mesh => mesh.computeWorldMatrix(true).clone());
    const delta = furnitureSceneDelta(C,source,current,[2,0.5,1.25]);
    bridge.apply({canonicalId:"chair",original:source,current,sourceScale:[1,1,1],currentScale:[2,0.5,1.25]});
    [one,two].forEach((mesh,i) => {
      const target = before[i]!.multiply(delta).asArray();
      const actual = mesh.computeWorldMatrix(true).asArray();
      target.forEach((v,j)=>expect(actual[j]).toBeCloseTo(v,4));
    });
    bridge.apply({canonicalId:"chair",original:source,current:source,sourceScale:[1,1,1],currentScale:[1,1,1]});
    [one,two].forEach((mesh,i) => {
      const target = before[i]!.asArray();
      const actual = mesh.computeWorldMatrix(true).asArray();
      target.forEach((v,j)=>expect(actual[j]).toBeCloseTo(v,5));
    });
    bridge.dispose();
    expect(one.parent).toBe(parent);
    expect(two.parent).toBe(parent);
  } finally {scene.dispose();engine.dispose();}
});

it("rejects animated or mixed-identity affine scenes without partial mesh mutations", () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const one = CreateBox("one", {}, scene), two = CreateBox("two", {}, scene);
    two.position.x = 3;
    one.animations.push({} as never);
    const bridge = new FurnitureGizmoBridge(scene,C,()=>[one,two]);
    const source = {position:[0,0,0] as const,yawRadians:Math.PI/4};
    const original = [one,two].map(mesh => mesh.computeWorldMatrix(true).clone());
    expect(() => bridge.apply({
      canonicalId:"chair",original:source,current:source,
      sourceScale:[1,1,1], currentScale:[2,1,1],
    })).toThrow(/regeneration/);
    [one,two].forEach((mesh,i)=>{
      original[i]!.asArray().forEach((v,j)=>expect(mesh.computeWorldMatrix(true).asArray()[j]).toBeCloseTo(v,5));
    });
    bridge.dispose();
  } finally {scene.dispose();engine.dispose();}
});
