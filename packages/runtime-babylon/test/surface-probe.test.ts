import {describe, expect, it} from "vitest";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine";
import {Scene} from "@babylonjs/core/scene";
import {StandardMaterial} from "@babylonjs/core/Materials/standardMaterial";
import {PickingInfo} from "@babylonjs/core/Collisions/pickingInfo";
import {Matrix, Vector3} from "@babylonjs/core/Maths/math.vector";
import type {BaseTexture} from "@babylonjs/core/Materials/Textures/baseTexture";
import {CreateBox} from "@babylonjs/core/Meshes/Builders/boxBuilder";
import {RawTexture} from "@babylonjs/core/Materials/Textures/rawTexture";
import {describeSurfacePick, diagnosticMipLevels, normalizeGpuRgb, clientToFramebufferPixel, inspectGpuMips} from "../src/surface-probe";

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

it("limits readback to three bounded mip levels with valid dimensions",()=>{
  expect(diagnosticMipLevels(1024,1024)).toEqual([0,5,10]);
  expect(diagnosticMipLevels(1,1)).toEqual([0]);
  expect(diagnosticMipLevels(1,512)).toEqual([0,4,9]);
  expect(diagnosticMipLevels(0,1024)).toEqual([]);
  expect(diagnosticMipLevels(65536,65536)).toEqual([]);
  expect(diagnosticMipLevels(Number.NaN,1)).toEqual([]);
});

it("distinguishes valid black GPU texels from unavailable readback",()=>{
  expect(normalizeGpuRgb(new Uint8Array([0,0,0,255]))).toEqual([0,0,0]);
  expect(normalizeGpuRgb(new Uint8Array([206,171,117,255]))).toEqual([206,171,117]);
  expect(normalizeGpuRgb(new Uint8Array([117,171,206,255]), "bgra")).toEqual([206,171,117]);
  expect(normalizeGpuRgb(new Float32Array([.5,.25,1,1]))).toEqual([128,64,255]);
  expect(normalizeGpuRgb(new Uint8Array([]))).toBeNull();
  expect(normalizeGpuRgb(null)).toBeNull();
});

it("maps client pixels to the correct backend origin and rejects invalid points",()=>{
 const rect={left:10,top:20,width:100,height:50};
 expect(clientToFramebufferPixel(10,20,rect,200,100,"webgpu")).toEqual([0,0]);
 expect(clientToFramebufferPixel(10,20,rect,200,100,"webgl")).toEqual([0,99]);
 expect(clientToFramebufferPixel(109.9,69.9,rect,200,100,"webgl")).toEqual([199,0]);
 expect(clientToFramebufferPixel(110,20,rect,200,100,"webgpu")).toBeNull();
 expect(clientToFramebufferPixel(NaN,20,rect,200,100,"webgpu")).toBeNull();
});

it("reads bounded mip texels at transformed and wrapped UV coordinates",async()=>{
 const calls:number[][]=[];
 const texture={getSize:()=>({width:9,height:5}),getInternalTexture:()=>({mipLevelCount:1,_hardwareTexture:{underlyingResource:{mipLevelCount:4}}}),getScene:()=>({getEngine:()=>({isWebGPU:true})}),
  getTextureMatrix:()=>{const m=Matrix.Identity();m.setRowFromFloats(2,.5,0,1,0);return m;},wrapU:1,wrapV:2,
  readPixels:async (_face:number,level:number,_buffer:unknown,_flush:boolean,_convert:boolean,x:number,y:number,w:number,h:number)=>{
   calls.push([level,x,y,w,h]);return new Uint8Array([1,2,3,255]);
  }} as unknown as BaseTexture;
 const result=await inspectGpuMips(texture,[.75,1.25]);
 expect(calls).toEqual([[0,2,3,1,1],[1,1,1,1,1],[3,0,0,1,1]]);
 expect(result.mips.map(m=>m.sampleLocation)).toEqual(["picked UV","picked UV","picked UV"]);
 expect(result.mips[0]?.coordinates).toEqual([2,3]);
});

it("does not read unallocated or unknown mip levels and labels unavailable coordinates",async()=>{
 const calls:number[]=[];
 const texture={getSize:()=>({width:8,height:4}),getInternalTexture:()=>({mipLevelCount:1,_hardwareTexture:{underlyingResource:{mipLevelCount:1}}}),getScene:()=>({getEngine:()=>({isWebGPU:true})}),
  getTextureMatrix:()=>Matrix.Identity(),wrapU:0,wrapV:0,
  readPixels:async (_face:number,level:number)=>{calls.push(level);return null;}} as unknown as BaseTexture;
 const result=await inspectGpuMips(texture);
 expect(calls).toEqual([0]);
 expect(result.mips[0]).toMatchObject({rgb:null,sampleLocation:"texture center",coordinates:[4,2]});
 const unknown={...texture,getSize:()=>({width:8,height:4}),getInternalTexture:()=>null} as unknown as BaseTexture;
 const missing=await inspectGpuMips(unknown,[NaN,0]);
 expect(missing.mips).toEqual([]);
 expect(missing.mipAvailabilityError).toBeTruthy();
});




it("labels WebGL generated mip levels as inferred",async()=>{
 const texture={getSize:()=>({width:8,height:4}),getInternalTexture:()=>({generateMipMaps:true,mipLevelCount:1}),
  getScene:()=>({getEngine:()=>({isWebGPU:false})}),getTextureMatrix:()=>Matrix.Identity(),wrapU:0,wrapV:0,
  readPixels:async()=>new Uint8Array([1,2,3,255])} as unknown as BaseTexture;
 const result=await inspectGpuMips(texture);
 expect(result.mipAvailability).toBe("inferred");
 expect(result.mips.map(m=>m.level)).toEqual([0,1,3]);
});


it("uses WebGPU texture allocation rather than the internal image texture count",async()=>{
 const calls:number[]=[];
 const texture={getSize:()=>({width:16,height:16}),
  getInternalTexture:()=>({mipLevelCount:1,_hardwareTexture:{underlyingResource:{mipLevelCount:5}}}),
  getScene:()=>({getEngine:()=>({isWebGPU:true})}),getTextureMatrix:()=>Matrix.Identity(),wrapU:0,wrapV:0,
  readPixels:async (_face:number,level:number)=>{calls.push(level);return new Uint8Array([1,2,3,255]);}} as unknown as BaseTexture;
 const result=await inspectGpuMips(texture);
 expect(calls).toEqual([0,2,4]);
 expect(result.mipAvailability).toBe("allocated");
});

it("does not infer WebGPU allocation from stale internal metadata",async()=>{
 const texture={getSize:()=>({width:16,height:16}),getInternalTexture:()=>({mipLevelCount:1,_hardwareTexture:{underlyingResource:{}}}),
  getScene:()=>({getEngine:()=>({isWebGPU:true})})} as unknown as BaseTexture;
 const result=await inspectGpuMips(texture);
 expect(result.mips).toEqual([]);
 expect(result.mipAvailabilityError).toBe("Allocated mip levels unavailable");
});
