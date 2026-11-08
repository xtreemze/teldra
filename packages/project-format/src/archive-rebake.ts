import {
  encodeStoredZip, openTeldraArchive, readScenePlacementOverrides,
  sha256Bytes, SCENE_PLACEMENT_OVERRIDES_PATH, SCENE_SOURCE_IFC_PATH, TeldraArchiveError,
  type OpenTeldraArchive, type ScenePlacementOverride, type SceneProvenance,
} from "./archive.js";
import { rebakeStaticGlb, type BrowserGlbRebake } from "./static-glb-rebake.js";

/** A required IFC4 authority check implemented by an actual IFC parser, not a GLB reader.
 * It must check source/current pose, scale and immutable mapped source triangles
 * for EVERY reconciliation entry, including entries with identity transforms.
 */
export type VerifySceneIfc = (
  sourceIFC:Uint8Array, currentIFC:Uint8Array, placements:readonly ScenePlacementOverride[],
)=>Promise<void>;

export interface BrowserArchiveRebake {
  readonly bytes:Uint8Array;
  readonly archive:OpenTeldraArchive;
  readonly geometry:BrowserGlbRebake;
}

/**
 * Atomic, opt-in **copy** of a saved canonical IFC project: build all new
 * derived geometry and SHA-256 manifests in memory, reopen/validate the ZIP,
 * and return bytes only after every step succeeds. Never writes original file,
 * never changes the authoritative IFC or source SH3D.
 */
export async function rebakeTeldraSceneCopy<T extends SceneProvenance & {
  scene:SceneProvenance["scene"] & {canonicalToScene:readonly number[]};
  nodes:readonly (SceneProvenance["nodes"][number] & {nodeKey:string})[];
}>(
  archive:OpenTeldraArchive,
  scene:T,
  verifyIFC:VerifySceneIfc,
):Promise<BrowserArchiveRebake>{
  if(scene.source.buildingPath!==archive.manifest.building.path)
    throw new TeldraArchiveError("Rebake scene source does not match canonical building path.");
  const record=await readScenePlacementOverrides(archive,scene);
  if(!record?.placements.length)
    throw new TeldraArchiveError("No saved IFC placement edits are available to regenerate.");
  const building=archive.entries.find(entry=>entry.path===archive.manifest.building.path);
  const original=archive.entries.find(entry=>entry.path===SCENE_SOURCE_IFC_PATH);
  const asset=archive.entries.find(entry=>entry.path===scene.scene.assetPath);
  const sceneManifest=archive.entries.find(entry=>entry.path==="scene.manifest.json");
  if(!building||!original||!asset||!sceneManifest||
     !archive.manifest.derived?.some(item=>item.path==="scene.manifest.json"))
    throw new TeldraArchiveError("Regeneration requires a complete saved IFC/GLB/scene manifest.");
  const storedScene=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(sceneManifest.bytes)) as unknown;
  if(JSON.stringify(storedScene)!==JSON.stringify(scene))
    throw new TeldraArchiveError("Loaded scene manifest differs from the saved archive source.");
  await verifyIFC(original.bytes,building.bytes,record.placements);
  // Only geometrically changed objects need a new mesh. Identity records are
  // consumed after IFC verification but should never allocate new triangles.
  const edited=record.placements.filter(item=>item.matrix.some(
    (v,i)=>Math.abs(v-([0,5,10,15].includes(i)?1:0))>1e-8
  ));
  if(!edited.length)
    throw new TeldraArchiveError("There are no changed IFC placements to bake.");
  const geometry=await rebakeStaticGlb(asset.bytes,scene,edited);
  const cloned={
    ...scene,
    source:{...scene.source,buildingSha256:archive.manifest.building.sha256},
    scene:{...scene.scene,assetSha256:geometry.bakedSha256},
  };
  const serializedScene=new TextEncoder().encode(JSON.stringify(cloned,null,2)+"\n");
  const newSceneHash=await sha256Bytes(serializedScene);
  const derived=(archive.manifest.derived??[])
    .filter(item=>item.path!==SCENE_SOURCE_IFC_PATH&&item.path!==SCENE_PLACEMENT_OVERRIDES_PATH)
    .map(item=>item.path===scene.scene.assetPath ? {...item,sha256:geometry.bakedSha256}
      : item.path==="scene.manifest.json" ? {...item,sha256:newSceneHash} : item);
  if(!derived.some(x=>x.path===scene.scene.assetPath))
    throw new TeldraArchiveError("Rebaked GLB must be a declared derived artifact.");
  const manifest={...archive.manifest,derived};
  const replacements=new Map<string,Uint8Array>([
    [scene.scene.assetPath,geometry.bytes],
    ["scene.manifest.json",serializedScene],
    ["project.json",new TextEncoder().encode(JSON.stringify(manifest,null,2)+"\n")],
  ]);
  const bytes=encodeStoredZip(archive.entries
    .filter(entry=>entry.path!==SCENE_SOURCE_IFC_PATH&&entry.path!==SCENE_PLACEMENT_OVERRIDES_PATH)
    .map(entry=>({path:entry.path,bytes:replacements.get(entry.path)??entry.bytes})));
  const reopened=await openTeldraArchive(bytes);
  // The new source IFC is now the current IFC: an unmodified scene is valid
  // and MUST have no stale reconciliation or original source IFC residue.
  if(await readScenePlacementOverrides(reopened,cloned)!==null)
    throw new TeldraArchiveError("Regenerated source was not cleanly rebased.");
  if(await sha256Bytes(reopened.entries.find(e=>e.path===scene.scene.assetPath)!.bytes)!==geometry.bakedSha256)
    throw new TeldraArchiveError("Generated scene GLB checksum failed readback.");
  if(reopened.manifest.building.sha256!==archive.manifest.building.sha256||
     reopened.manifest.twin.sha256!==archive.manifest.twin.sha256)
    throw new TeldraArchiveError("Rebake altered canonical building or twin.");
  return {bytes,archive:reopened,geometry};
}
