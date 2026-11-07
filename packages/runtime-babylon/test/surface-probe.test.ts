import {describe, expect, it} from "vitest";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine";
import {Scene} from "@babylonjs/core/scene";
import {StandardMaterial} from "@babylonjs/core/Materials/standardMaterial";
import {PickingInfo} from "@babylonjs/core/Collisions/pickingInfo";
import {Vector3} from "@babylonjs/core/Maths/math.vector";
import {CreateBox} from "@babylonjs/core/Meshes/Builders/boxBuilder";
import {RawTexture} from "@babylonjs/core/Materials/Textures/rawTexture";
import {describeSurfacePick} from "../src/surface-probe";

describe("surface probe",()=>{
 it("reports the actual material and texture without mutation or unsafe embedded names",()=>{
  const engine=new NullEngine(),scene=new Scene(engine);
  try {
   const mesh=CreateBox("actual surface",{},scene);
   const material=new StandardMaterial("source Phong",scene);
   material.metadata={gltf:{extras:{teldraSourceMaterial:{format:"wavefront-mtl",Kd:[1,1,1],map_Kd:"floor.jpeg"}}}};
   const texture=RawTexture.CreateRGBTexture(new Uint8Array([41,52,65]),1,1,scene,false,false);
   material.diffuseTexture=texture;mesh.material=material;
   const picked=new PickingInfo();picked.hit=true;picked.pickedMesh=mesh;picked.faceId=-1;
   picked.distance=7.12345;picked.pickedPoint=new Vector3(1,0,2);
   const original=material.diffuseTexture;
   const result=describeSurfacePick(picked,{canonicalId:"sh3d:room:floor",nodeKey:"floor-node"});
   expect(result).toMatchObject({canonicalId:"sh3d:room:floor",material:"source Phong",texture:"floor.jpeg",distanceMetres:7.123,originalKd:[1,1,1],worldPoint:[1,0,2]});
   expect(result?.uv).toBeNull();
   expect(material.diffuseTexture).toBe(original);
   expect(material.metadata.gltf.extras.teldraSourceMaterial.Kd).toEqual([1,1,1]);
  }finally{scene.dispose();engine.dispose();}
 });
 it("rejects misses and reports untextured occluding surfaces",()=>{
  const engine=new NullEngine(),scene=new Scene(engine);
  try {
   const mesh=CreateBox("overlying plane",{},scene);mesh.material=new StandardMaterial("solid black",scene);
   const picked=new PickingInfo();picked.hit=true;picked.pickedMesh=mesh;picked.distance=2.5;
   picked.faceId=-1;
   expect(describeSurfacePick(picked,null)).toMatchObject({canonicalId:null,mesh:"overlying plane",material:"solid black",texture:null,textureReady:false,worldPoint:null});
   picked.hit=false;
   expect(describeSurfacePick(picked,null)).toBeNull();
  }finally{scene.dispose();engine.dispose();}
 });
});
