import {describe,expect,it} from "vitest";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine";
import {Scene} from "@babylonjs/core/scene";
import {Matrix,Quaternion,Vector3} from "@babylonjs/core/Maths/math.vector";
import {CreateBox} from "@babylonjs/core/Meshes/Builders/boxBuilder";
import {StandardMaterial} from "@babylonjs/core/Materials/standardMaterial";
import {measureFurnitureTriangleBounds} from "../src/furniture-bounds.js";

const C = Matrix.FromArray([1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1]);

describe("measured triangle bounds in source IFC-local XYZ metres",() => {
  it("measures actual vertices across a rotated, offset native furniture mesh",() => {
    const engine=new NullEngine(), scene=new Scene(engine);
    try {
      const mesh=CreateBox("geometry",{width:2,height:4,depth:3},scene);
      mesh.material=new StandardMaterial("mat",scene);
      const original={position:[1,2,0.6] as const,yawRadians:Math.PI/4};
      mesh.position.copyFrom(Vector3.TransformCoordinates(Vector3.FromArray(original.position),C));
      mesh.rotationQuaternion=Quaternion.RotationAxis(Vector3.Up(),original.yawRadians);
      const before = mesh.computeWorldMatrix(true).clone();
      const result = measureFurnitureTriangleBounds([mesh],C,original);
      expect(result.meshParts).toBe(1);
      expect(result.triangles).toBe(12);
      result.size.forEach((v,i)=>expect(v).toBeCloseTo([2,3,4][i]!,5));
      result.minimum.forEach((v,i)=>expect(v).toBeCloseTo([-1,-1.5,-2][i]!,5));
      // A preview must not mutate the source measurement baseline.
      mesh.position.set(30,40,50);
      const stable=measureFurnitureTriangleBounds([mesh],C,original,new Map([[mesh,before]]));
      stable.size.forEach((v,i)=>expect(v).toBeCloseTo(result.size[i]!,5));
    } finally {scene.dispose();engine.dispose();}
  });

  it("rejects nonstatic or degenerate geometry instead of advertising dimensions",() => {
    const engine=new NullEngine(),scene=new Scene(engine);
    try {
      const mesh=CreateBox("geometry",{},scene);
      mesh.material=new StandardMaterial("mat",scene);
      const pose={position:[0,0,0] as const,yawRadians:0};
      const measured=measureFurnitureTriangleBounds([mesh],C,pose);
      expect(measured.size).toEqual([1,1,1]);
      mesh.animations.push({} as never);
      expect(()=>measureFurnitureTriangleBounds([mesh],C,pose)).toThrow(/static/);
      mesh.animations.pop();
      expect(()=>measureFurnitureTriangleBounds([],C,pose)).toThrow(/mesh parts/);
    } finally {scene.dispose();engine.dispose();}
  });
});
