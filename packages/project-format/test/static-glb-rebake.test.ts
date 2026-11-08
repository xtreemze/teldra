import { describe, expect, it } from "vitest";
import { rebakeStaticGlb } from "../src/static-glb-rebake.js";
import { sha256Bytes, type ScenePlacementOverride } from "../src/archive.js";

const C=[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1];
const delta=[1.5,0.5,0,0,0.3,1.2,0,0,0,0,2,0,2,-1,0.5,1];
const chair="16W6mYG0DO8hR8U$bz6FSv",table="1nVyzgM_L0swCqTNOVUCx6";
const pos=[[0,0,0],[1,0,0],[0,0,1]];
function makeGlb(hierarchy=false){
  const bin=new Uint8Array(128),dv=new DataView(bin.buffer);
  const positions=[0,0,0,1,0,0,0,0,1],normals=[0,-1,0,0,-1,0,0,-1,0],uvs=[0,0,1,0,0,1];
  positions.forEach((v,i)=>dv.setFloat32(i*4,v,true));
  normals.forEach((v,i)=>dv.setFloat32(36+i*4,v,true));
  uvs.forEach((v,i)=>dv.setFloat32(72+i*4,v,true));
  [0,1,2].forEach((v,i)=>dv.setUint32(96+i*4,v,true));
  bin.set([137,80,78,71,13,10,26,10],108);
  const meshes=[{primitives:[{mode:4,indices:3,attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2},material:0}]}];
  const nodes:any[]=[
    {mesh:0,extras:{teldra:{canonicalId:"chair",ifcGlobalId:chair,nodeKey:"chair:0"}}},
    {mesh:0,extras:{teldra:{canonicalId:"table",ifcGlobalId:table,nodeKey:"table:0"}}},
  ];
  if(hierarchy){
    const q=Math.SQRT1_2;
    nodes.push({translation:[1,2,3],rotation:[0,0,q,q],children:[0,1]});
  }
  const doc={
    asset:{version:"2.0"},scene:0,scenes:[{nodes:hierarchy?[2]:[0,1]}],nodes,meshes,
    buffers:[{byteLength:bin.length}],
    bufferViews:[
      {buffer:0,byteOffset:0,byteLength:36},
      {buffer:0,byteOffset:36,byteLength:36},
      {buffer:0,byteOffset:72,byteLength:24},
      {buffer:0,byteOffset:96,byteLength:12},
      {buffer:0,byteOffset:108,byteLength:8},
    ],
    accessors:[
      {bufferView:0,componentType:5126,count:3,type:"VEC3"},
      {bufferView:1,componentType:5126,count:3,type:"VEC3"},
      {bufferView:2,componentType:5126,count:3,type:"VEC2"},
      {bufferView:3,componentType:5125,count:3,type:"SCALAR"},
    ],
    materials:[{name:"source material"}],images:[{bufferView:4,mimeType:"image/png"}],
    textures:[{source:0}],samplers:[{}],
  };
  const json=new TextEncoder().encode(JSON.stringify(doc)),len=(json.length+3)&~3;
  const out=new Uint8Array(12+8+len+8+bin.length);const v=new DataView(out.buffer);
  v.setUint32(0,0x46546c67,true);v.setUint32(4,2,true);v.setUint32(8,out.length,true);
  v.setUint32(12,len,true);v.setUint32(16,0x4e4f534a,true);out.fill(32,20,20+len);out.set(json,20);
  v.setUint32(20+len,bin.length,true);v.setUint32(24+len,0x004e4942,true);out.set(bin,28+len);
  return out;
}
function parseGlb(glb:Uint8Array){
  const v=new DataView(glb.buffer,glb.byteOffset,glb.byteLength);
  const len=v.getUint32(12,true);
  const doc=JSON.parse(new TextDecoder().decode(glb.subarray(20,20+len)).trim());
  const binary=glb.subarray(28+len);
  const values=(acc:number)=>{
    const a=doc.accessors[acc],view=doc.bufferViews[a.bufferView];
    const size=a.type==="VEC3"?3:a.type==="VEC4"?4:a.type==="VEC2"?2:1;
    const viewBytes=new DataView(binary.buffer,binary.byteOffset,binary.byteLength);
    return Array.from({length:a.count*size},(_,i)=>viewBytes.getFloat32((view.byteOffset??0)+(a.byteOffset??0)+i*4,true));
  };
  return {doc,binary,values};
}
const placement:ScenePlacementOverride={canonicalId:"chair",ifcGlobalId:chair,matrix:delta,scale:[1.5,1.2,2]};
async function manifest(glb:Uint8Array){
  return {source:{buildingPath:"building.ifc",buildingSha256:"a".repeat(64)},
    scene:{assetPath:"building.glb",assetSha256:await sha256Bytes(glb),canonicalToScene:C},
    nodes:[{canonicalId:"chair",ifcGlobalId:chair,nodeKey:"chair:0"},
      {canonicalId:"table",ifcGlobalId:table,nodeKey:"table:0"}]};
}
const near=(a:readonly number[],b:readonly number[],tolerance=2e-5)=>{
  expect(a).toHaveLength(b.length);
  a.forEach((v,i)=>expect(Math.abs(v-b[i]!)).toBeLessThan(tolerance));
};
describe("browser static GLB rebake",()=>{
  it("copies only target geometry, preserving original BIN bytes, material, image, UV, identity",async()=>{
    const source=makeGlb();const before=parseGlb(source);
    const result=await rebakeStaticGlb(source,await manifest(source),[placement]);
    expect(result.triangleCount).toBe(1);expect(result.editedObjectCount).toBe(1);
    expect(result.bakedSha256).toBe(await sha256Bytes(result.bytes));
    const after=parseGlb(result.bytes);
    expect(after.binary.subarray(0,128)).toEqual(before.binary);
    expect(after.doc.materials).toEqual(before.doc.materials);
    expect(after.doc.images).toEqual(before.doc.images);
    expect(after.doc.textures).toEqual(before.doc.textures);
    expect(after.doc.nodes[0].extras).toEqual(before.doc.nodes[0].extras);
    expect(after.doc.nodes[1]).toEqual(before.doc.nodes[1]);
    expect(after.doc.meshes[0]).toEqual(before.doc.meshes[0]);
    expect(after.doc.nodes[0].mesh).not.toBe(after.doc.nodes[1].mesh);
    const prim=after.doc.meshes[after.doc.nodes[0].mesh].primitives[0];
    expect(prim.material).toBe(0);
    expect(prim.indices).toBe(3);
    expect(prim.attributes.TEXCOORD_0).toBe(2);
    near(after.values(prim.attributes.POSITION).slice(3,6),[3.5,0.5,0.5]);
    const normals=after.values(prim.attributes.NORMAL);
    expect(Math.hypot(...normals.slice(0,3))).toBeCloseTo(1,6);
    const p=after.values(prim.attributes.POSITION);
    const a=[p[3]-p[0],p[4]-p[1],p[5]-p[2]];
    const b=[p[6]-p[0],p[7]-p[1],p[8]-p[2]];
    expect(a.reduce((v,x,i)=>v+x*normals[i],0)).toBeCloseTo(0,5);
    expect(b.reduce((v,x,i)=>v+x*normals[i],0)).toBeCloseTo(0,5);
    expect((await rebakeStaticGlb(source,await manifest(source),[placement])).bytes).toEqual(result.bytes);
  });
  it("conjugates IFC delta through a parented, cross-identity glTF transform",async()=>{
    const source=makeGlb(true);
    const out=parseGlb((await rebakeStaticGlb(source,await manifest(source),[placement])).bytes);
    const positions=out.values(out.doc.meshes[out.doc.nodes[0].mesh].primitives[0].attributes.POSITION);
    // Original source vertex [1,0,0] under shared glTF parent W:
    // glTF world [1,3,3] -> canonical [1,-3,3].
    // IFC delta -> canonical [2.6,-4.1,6.5] -> glTF [2.6,6.5,4.1].
    // W^-1 brings this point back to local glTF [4.5,-1.6,1.1].
    near(positions.slice(3,6),[4.5,-1.6,1.1],1e-4);
    expect(out.doc.nodes[2].children).toEqual([0,1]);
    expect(out.doc.nodes[1].mesh).toBe(0);
  });
  it("fails closed for hash mismatch, missing identities and unsafe mesh transforms",async()=>{
    const source=makeGlb(),valid=await manifest(source);
    await expect(rebakeStaticGlb(source,{...valid,scene:{...valid.scene,assetSha256:"0".repeat(64)}},[placement])).rejects.toThrow(/SHA/);
    await expect(rebakeStaticGlb(source,valid,[{...placement,canonicalId:"unknown"}])).rejects.toThrow(/identity/);
    await expect(rebakeStaticGlb(source,valid,[placement,placement])).rejects.toThrow(/identity/);
    await expect(rebakeStaticGlb(source,valid,[{...placement,matrix:[-1,...delta.slice(1)]}])).rejects.toThrow();
    const bad=makeGlb(true);const old=parseGlb(bad);
    old.doc.nodes[2].scale=[-1,1,1];
    const rewritten=()=>{ // Mutation helper for bad test GLB
      const sourceDoc=old.doc;const json=new TextEncoder().encode(JSON.stringify(sourceDoc));
      const size=(json.length+3)&~3;const output=new Uint8Array(28+size+old.binary.length),v=new DataView(output.buffer);
      v.setUint32(0,0x46546c67,true);v.setUint32(4,2,true);v.setUint32(8,output.length,true);
      v.setUint32(12,size,true);v.setUint32(16,0x4e4f534a,true);
      output.fill(32,20,20+size);output.set(json,20);
      v.setUint32(20+size,old.binary.length,true);v.setUint32(24+size,0x004e4942,true);
      output.set(old.binary,28+size);return output;
    };
    const altered=rewritten();
    await expect(rebakeStaticGlb(altered,await manifest(altered),[placement])).rejects.toThrow(/mirrored/);
  });
});
