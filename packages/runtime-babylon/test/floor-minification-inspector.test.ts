import {describe, expect, it} from "vitest";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine";
import {Scene} from "@babylonjs/core/scene";
import {StandardMaterial} from "@babylonjs/core/Materials/standardMaterial";
import {RawTexture} from "@babylonjs/core/Materials/Textures/rawTexture";
import {Texture} from "@babylonjs/core/Materials/Textures/texture";
import {FloorMinificationInspector} from "../src/floor-minification-inspector";

describe("source-safe floor texture minification diagnostics",()=>{
 it("compares source, no-mips, and anisotropic sampling and restores the exact source sampler",()=>{
  const engine=new NullEngine(),scene=new Scene(engine);
  try {
   const image=RawTexture.CreateRGBTexture(new Uint8Array([30,55,65,240,240,240]),2,1,scene,true,false);
   image.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
   image.anisotropicFilteringLevel=3;
   const floor=new StandardMaterial("floor",scene);
   floor.diffuseTexture=image;
   const other=new StandardMaterial("wall",scene);
   const wallImage=RawTexture.CreateRGBTexture(new Uint8Array([200,200,200]),1,1,scene,true,false);
   other.diffuseTexture=wallImage;
   const originalUv=image.uScale,originalWallSampling=wallImage.samplingMode;
   const inspector=new FloorMinificationInspector(16);
   inspector.register(floor);
   inspector.register(floor);
   expect(inspector.textureCount).toBe(1);
   expect(inspector.currentMode).toBe("auto");
   expect(image.samplingMode).toBe(Texture.TRILINEAR_SAMPLINGMODE);
   expect(image.anisotropicFilteringLevel).toBe(3);
   inspector.setMode("base-level");
   expect(image.samplingMode).toBe(Texture.LINEAR_LINEAR);
   expect(image.anisotropicFilteringLevel).toBe(1);
   inspector.setMode("anisotropic");
   expect(image.samplingMode).toBe(Texture.TRILINEAR_SAMPLINGMODE);
   expect(image.anisotropicFilteringLevel).toBe(8);
   inspector.setMode("source");
   expect(image.samplingMode).toBe(Texture.TRILINEAR_SAMPLINGMODE);
   expect(image.anisotropicFilteringLevel).toBe(3);
   expect(image.uScale).toBe(originalUv);
   expect(wallImage.samplingMode).toBe(originalWallSampling);
   expect(other.diffuseTexture).toBe(wallImage);
   expect(floor.diffuseTexture).toBe(image);
   inspector.restore();
   expect(inspector.textureCount).toBe(0);
  } finally {scene.dispose();engine.dispose();}
 });
 it("clamps anisotropy to hardware and validates modes",()=>{
  const engine=new NullEngine(),scene=new Scene(engine);
  try {
   const image=RawTexture.CreateRGBTexture(new Uint8Array([150,150,150]),1,1,scene,true,false);
   const mat=new StandardMaterial("floor",scene);mat.diffuseTexture=image;
   const inspector=new FloorMinificationInspector(2);
   inspector.register(mat);
   inspector.setMode("anisotropic");
   expect(image.anisotropicFilteringLevel).toBe(2);
   expect(()=>inspector.setMode("invalid" as "source")).toThrow("Unsupported");
   inspector.restore();
  }finally{scene.dispose();engine.dispose();}
 });
});

it("automatically preserves source mipmaps and retains an explicit base-image fallback",()=>{
 const engine=new NullEngine(),scene=new Scene(engine);
 try {
  const image=RawTexture.CreateRGBTexture(new Uint8Array([42,56,62]),1,1,scene,true,false);
  image.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);image.anisotropicFilteringLevel=4;
  const material=new StandardMaterial("room",scene);material.diffuseTexture=image;
  const inspector=new FloorMinificationInspector(16);
  inspector.register(material);
  expect(inspector.currentMode).toBe("auto");
  expect(image.samplingMode).toBe(Texture.TRILINEAR_SAMPLINGMODE);
  expect(image.anisotropicFilteringLevel).toBe(4);
  inspector.setMode("source");
  expect(image.samplingMode).toBe(Texture.TRILINEAR_SAMPLINGMODE);
  inspector.setMode("base-level");
  expect(image.samplingMode).toBe(Texture.LINEAR_LINEAR);
  inspector.setMode("auto");
  expect(image.samplingMode).toBe(Texture.TRILINEAR_SAMPLINGMODE);
  expect(material.diffuseTexture).toBe(image);
  inspector.restore();
  expect(image.samplingMode).toBe(Texture.TRILINEAR_SAMPLINGMODE);
  expect(image.anisotropicFilteringLevel).toBe(4);
 } finally {scene.dispose();engine.dispose();}
});
