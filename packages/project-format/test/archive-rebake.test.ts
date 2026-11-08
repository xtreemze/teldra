import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import {
  encodeStoredZip, openTeldraArchive, readScenePlacementOverrides, sha256Bytes,
  SCENE_PLACEMENT_OVERRIDES_PATH, SCENE_SOURCE_IFC_PATH,
} from "../src/archive.js";
import { rebakeTeldraSceneCopy } from "../src/archive-rebake.js";

const enc=new TextEncoder();
const guid="16W6mYG0DO8hR8U$bz6FSv",id="chair";
const C=[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1];
const matrix=[1.5,0.5,0,0,0.5,1.5,0,0,0,0,1.25,0,2,3,0,1];
function glb(){
  const bytes=new Uint8Array(48),view=new DataView(bytes.buffer);
  [0,0,0,1,0,0,0,0,1].forEach((v,i)=>view.setFloat32(i*4,v,true));
  [0,1,2].forEach((v,i)=>view.setUint32(36+i*4,v,true));
  const doc={
    asset:{version:"2.0"},buffers:[{byteLength:48}],bufferViews:[
      {buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:12}
    ],accessors:[
      {bufferView:0,componentType:5126,count:3,type:"VEC3"},
      {bufferView:1,componentType:5125,count:3,type:"SCALAR"},
    ],
    meshes:[{primitives:[{attributes:{POSITION:0},indices:1,mode:4}]}],
    nodes:[{mesh:0,extras:{teldra:{canonicalId:id,ifcGlobalId:guid,nodeKey:"chair:0"}}}],
    scene:0,scenes:[{nodes:[0]}],
  };
  const json=enc.encode(JSON.stringify(doc)),jsonLength=(json.length+3)&~3;
  const result=new Uint8Array(28+jsonLength+bytes.length),dv=new DataView(result.buffer);
  dv.setUint32(0,0x46546c67,true);dv.setUint32(4,2,true);dv.setUint32(8,result.length,true);
  dv.setUint32(12,jsonLength,true);dv.setUint32(16,0x4e4f534a,true);
  result.fill(32,20,20+jsonLength);result.set(json,20);
  dv.setUint32(20+jsonLength,bytes.length,true);dv.setUint32(24+jsonLength,0x004e4942,true);
  result.set(bytes,28+jsonLength);return result;
}
async function source(){
  const native=glb(),before=enc.encode("source IFC"),after=enc.encode("current IFC");
  const scene={
    schemaVersion:"0.1.0",
    coordinateSystem:{unit:"metre",handedness:"right",upAxis:"Z"},
    source:{buildingPath:"building.ifc",buildingSha256:await sha256Bytes(before)},
    scene:{assetPath:"building.glb",assetSha256:await sha256Bytes(native),format:"glb",canonicalToScene:C},
    nodes:[{nodeKey:"chair:0",canonicalId:id,ifcGlobalId:guid,kind:"building",renderPart:"body"}],
  };
  const twin=structuredClone(goldenTwin);
  if(!twin.building.refs.some(x=>x.id===id))
    twin.building.refs.push({id,ifcGlobalId:guid,kind:"furniture",name:"Chair"} as never);
  const twinBytes=enc.encode(JSON.stringify(twin));
  const placement={canonicalId:id,ifcGlobalId:guid,matrix,scale:[2,1,1.25] as const};
  const overrides={
    version:2,sourceBuildingSha256:await sha256Bytes(before),
    buildingSha256:await sha256Bytes(after),sceneAssetSha256:await sha256Bytes(native),
    placements:[placement],
  };
  const entries=[
    {path:"building.ifc",bytes:after},{path:"twin.json",bytes:twinBytes},
    {path:"building.glb",bytes:native},
    {path:"scene.manifest.json",bytes:enc.encode(JSON.stringify(scene))},
    {path:SCENE_SOURCE_IFC_PATH,bytes:before},
    {path:SCENE_PLACEMENT_OVERRIDES_PATH,bytes:enc.encode(JSON.stringify(overrides))},
    {path:"source.sh3d",bytes:enc.encode("immutable SH3D source")},
  ];
  const project={
    formatVersion:"0.1.0",
    building:{path:"building.ifc",sha256:await sha256Bytes(after)},
    twin:{path:"twin.json",sha256:await sha256Bytes(twinBytes)},
    derived:await Promise.all(entries.filter(e=>!["building.ifc","twin.json"].includes(e.path))
      .map(async e=>({path:e.path,sha256:await sha256Bytes(e.bytes)}))),
  };
  const archive=await openTeldraArchive(encodeStoredZip([
    ...entries,{path:"project.json",bytes:enc.encode(JSON.stringify(project))}
  ]));
  return {archive,scene,original:before,current:after};
}
describe("browser atomic project scene rebake",()=>{
  it("verifies IFC authority before returning any output, preserves original assets, reopens cleanly",async()=>{
    const {archive,scene,original,current}=await source();
    let verified=0;
    const result=await rebakeTeldraSceneCopy(archive,scene,async (before,after,placements)=>{
      verified++;expect(before).toEqual(original);expect(after).toEqual(current);
      expect(placements).toHaveLength(1);
    });
    expect(verified).toBe(1);
    expect(result.geometry.triangleCount).toBe(1);
    expect(result.geometry.editedObjectCount).toBe(1);
    const originalGlb=archive.entries.find(e=>e.path==="building.glb")!;
    const rebaked=result.archive.entries.find(e=>e.path==="building.glb")!;
    expect(rebaked.bytes).not.toEqual(originalGlb.bytes);
    expect(archive.entries.find(e=>e.path==="building.glb")!.bytes).toEqual(originalGlb.bytes);
    expect(result.archive.entries.find(e=>e.path==="building.ifc")!.bytes).toEqual(current);
    expect(result.archive.entries.find(e=>e.path==="twin.json")!.bytes).toEqual(
      archive.entries.find(e=>e.path==="twin.json")!.bytes,
    );
    expect(result.archive.entries.find(e=>e.path==="source.sh3d")!.bytes).toEqual(
      archive.entries.find(e=>e.path==="source.sh3d")!.bytes,
    );
    expect(result.archive.entries.some(e=>e.path===SCENE_SOURCE_IFC_PATH)).toBe(false);
    expect(result.archive.entries.some(e=>e.path===SCENE_PLACEMENT_OVERRIDES_PATH)).toBe(false);
    const rebasedScene=JSON.parse(new TextDecoder().decode(
      result.archive.entries.find(e=>e.path==="scene.manifest.json")!.bytes));
    expect(rebasedScene.source.buildingSha256).toBe(await sha256Bytes(current));
    expect(rebasedScene.scene.assetSha256).toBe(await sha256Bytes(rebaked.bytes));
    expect(await readScenePlacementOverrides(result.archive,rebasedScene)).toBeNull();
    expect((await openTeldraArchive(result.bytes)).manifest.derived).toEqual(result.archive.manifest.derived);
    expect((await rebakeTeldraSceneCopy(archive,scene,async()=>undefined)).bytes).toEqual(result.bytes);
  });
  it("fails closed when IFC verification rejects or reconciliation is tampered",async()=>{
    const {archive,scene}=await source();
    await expect(rebakeTeldraSceneCopy(archive,scene,async()=>{throw new Error("Changed IFC face indices");}))
      .rejects.toThrow("Changed IFC face indices");
    const broken={...scene,scene:{...scene.scene,assetSha256:"0".repeat(64)}};
    await expect(rebakeTeldraSceneCopy(archive,broken,async()=>undefined)).rejects.toThrow();
    // No saved source/delta can be consumed twice.
    const result=await rebakeTeldraSceneCopy(archive,scene,async()=>undefined);
    await expect(rebakeTeldraSceneCopy(result.archive,scene,async()=>undefined)).rejects.toThrow();
  });
});
