/** Browser-native, source-preserving GLB derivative rebake for static indexed triangles.
 * The IFC placement reconciler must validate every input delta against the
 * original/current IFC *before* invoking this pure GLB operation.
 */
import { sha256Bytes, TeldraArchiveError, type ScenePlacementOverride, type SceneProvenance } from "./archive.js";

type Matrix4 = number[];
type GlbAccessor = {bufferView:number;byteOffset?:number;componentType:number;count:number;type:string;min?:number[];max?:number[];sparse?:unknown;normalized?:boolean;[key:string]:unknown};
type GlbView = {buffer?:number;byteOffset?:number;byteLength:number;byteStride?:number;target?:number;[key:string]:unknown};
type GlbPrimitive = {mode?:number;indices?:number;attributes:Record<string,number>;targets?:unknown;extensions?:unknown;[key:string]:unknown};
type GlbMesh = {primitives:GlbPrimitive[];weights?:unknown;[key:string]:unknown};
type GlbNode = {mesh?:number;children?:number[];matrix?:number[];translation?:number[];rotation?:number[];scale?:number[];skin?:unknown;weights?:unknown;extensions?:unknown;extras?:{teldra?:{canonicalId?:string;ifcGlobalId?:string;nodeKey?:string};[key:string]:unknown};[key:string]:unknown};
type GlbDocument = {asset?:{version?:string};buffers:{byteLength:number;uri?:string}[];bufferViews:GlbView[];accessors:GlbAccessor[];meshes:GlbMesh[];nodes:GlbNode[];scenes:{nodes:number[]}[];scene?:number;animations?:unknown;skins?:unknown;extensionsUsed?:string[];[key:string]:unknown};
export interface BrowserGlbRebake {
  readonly bytes:Uint8Array;
  readonly sourceSha256:string;
  readonly bakedSha256:string;
  readonly triangleCount:number;
  readonly editedObjectCount:number;
}

const JSON_CHUNK=0x4e4f534a, BIN_CHUNK=0x004e4942, MAGIC=0x46546c67;
const MAX_FILE=512*1024*1024, MAX_VERTICES=10_000_000;
const enc=new TextEncoder(), dec=new TextDecoder("utf-8",{fatal:true});
const fail=(message:string):never=>{throw new TeldraArchiveError("GLB regeneration: "+message);};
const finite=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);
const matrixIdentity=():Matrix4=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const product=(a:readonly number[],b:readonly number[]):Matrix4=>{
  const out=Array<number>(16).fill(0);
  for(let col=0;col<4;col++)for(let row=0;row<4;row++)
    for(let k=0;k<4;k++)out[col*4+row]!+=a[k*4+row]!*b[col*4+k]!;
  return out;
};
const invAffine=(m:readonly number[]):Matrix4=>{
  if(m.length!==16||!m.every(finite)||![3,7,11].every(i=>Math.abs(m[i]!)<1e-7)||Math.abs(m[15]!-1)>1e-7)
    return fail("Source node or placement matrix is not finite affine.");
  const [a,b,c,d,e,f,g,h,i]=[m[0]!,m[4]!,m[8]!,m[1]!,m[5]!,m[9]!,m[2]!,m[6]!,m[10]!];
  const det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  const magnitude=Math.max(...m.map(v=>Math.abs(v)),1);
  if(!finite(det)||det<=1e-10||Math.abs(det)<1e-9*Math.max(1,(Math.max(Math.abs(a),Math.abs(e),Math.abs(i)))**3)||magnitude>1e6)
    return fail("Source node or placement is mirrored, singular or outside stable bounds.");
  const inverse=matrixIdentity();
  const co=[(e*i-f*h)/det,(f*g-d*i)/det,(d*h-e*g)/det,
    (c*h-b*i)/det,(a*i-c*g)/det,(b*g-a*h)/det,
    (b*f-c*e)/det,(c*d-a*f)/det,(a*e-b*d)/det];
  for(let row=0;row<3;row++)for(let col=0;col<3;col++)inverse[col*4+row]=co[col*3+row]!;
  for(let row=0;row<3;row++)inverse[12+row]=-(inverse[row]!*m[12]!+inverse[4+row]!*m[13]!+inverse[8+row]!*m[14]!);
  if(inverse.some(v=>!finite(v)||Math.abs(v)>1e9))return fail("Source affine inverse is unstable.");
  return inverse;
};
const transform=(m:readonly number[], x:number,y:number,z:number,point:boolean):number[]=>{
  const w=point?1:0;
  return [m[0]!*x+m[4]!*y+m[8]!*z+m[12]!*w,
    m[1]!*x+m[5]!*y+m[9]!*z+m[13]!*w,
    m[2]!*x+m[6]!*y+m[10]!*z+m[14]!*w];
};
const normalize=(v:number[]):number[]=>{
  const n=Math.hypot(...v);
  if(!finite(n)||n<1e-9)return fail("Degenerate source normal or tangent.");
  return v.map(x=>x/n);
};
const checkedIndex=(value:unknown,length:number,what:string):number=>{
  if(!Number.isInteger(value)||(value as number)<0||(value as number)>=length)return fail("Invalid "+what+" index.");
  return value as number;
};
function nodeFrames(doc:GlbDocument):{frames:Matrix4[];reachable:Set<number>}{
  if(!Array.isArray(doc.nodes)||doc.nodes.length>MAX_VERTICES)return fail("Invalid GLB nodes.");
  const parent=new Map<number,number>();
  for(let i=0;i<doc.nodes.length;i++){
    const children=doc.nodes[i]!.children??[];
    if(!Array.isArray(children)||new Set(children).size!==children.length)return fail("Invalid GLB node hierarchy.");
    for(const child of children){
      checkedIndex(child,doc.nodes.length,"child node");
      if(parent.has(child))return fail("GLB node has multiple parents.");
      parent.set(child,i);
    }
  }
  const frames:(Matrix4|undefined)[]=Array(doc.nodes.length).fill(undefined),visiting=new Set<number>();
  const world=(index:number):Matrix4=>{
    if(frames[index])return frames[index]!;
    if(visiting.has(index))return fail("Cyclic GLB node hierarchy.");
    visiting.add(index);
    const node=doc.nodes[index]!;
    let local:Matrix4;
    if(node.matrix!==undefined){
      if(node.rotation!==undefined||node.translation!==undefined||node.scale!==undefined)return fail("Source node combines matrix with TRS.");
      local=[...node.matrix];
    }else{
      const t=node.translation??[0,0,0],q=node.rotation??[0,0,0,1],s=node.scale??[1,1,1];
      if(t.length!==3||q.length!==4||s.length!==3||![...t,...q,...s].every(finite))return fail("Invalid source TRS.");
      const [x,y,z,w]=q;
      if(Math.abs(Math.hypot(...q)-1)>1e-5)return fail("Source rotation quaternion must be unit length.");
      local=[
        (1-2*(y!*y!+z!*z!))*s[0]!,2*(x!*y!+z!*w!)*s[0]!,2*(x!*z!-y!*w!)*s[0]!,0,
        2*(x!*y!-z!*w!)*s[1]!, (1-2*(x!*x!+z!*z!))*s[1]!,2*(y!*z!+x!*w!)*s[1]!,0,
        2*(x!*z!+y!*w!)*s[2]!,2*(y!*z!-x!*w!)*s[2]!, (1-2*(x!*x!+y!*y!))*s[2]!,0,
        t[0]!,t[1]!,t[2]!,1,
      ];
    }
    invAffine(local);
    const combined=parent.has(index)?product(world(parent.get(index)!),local):local;
    invAffine(combined);
    visiting.delete(index);
    frames[index]=combined;
    return combined;
  };
  for(let i=0;i<doc.nodes.length;i++)world(i);
  const scene=checkedIndex(doc.scene??0,doc.scenes?.length??0,"active scene");
  const roots=doc.scenes[scene]?.nodes;
  if(!Array.isArray(roots))return fail("Missing GLB active scene roots.");
  const reachable=new Set<number>(),stack=[...roots];
  while(stack.length){
    const next=checkedIndex(stack.pop(),doc.nodes.length,"reachable node");
    if(reachable.has(next))continue;
    reachable.add(next);stack.push(...(doc.nodes[next]!.children??[]));
  }
  return {frames:frames as Matrix4[],reachable};
}
function parseGlb(source:Uint8Array):{doc:GlbDocument;binary:Uint8Array}{
  if(source.length<28||source.length>MAX_FILE)return fail("GLB exceeds safe size or is truncated.");
  const view=new DataView(source.buffer,source.byteOffset,source.byteLength);
  if(view.getUint32(0,true)!==MAGIC||view.getUint32(4,true)!==2||view.getUint32(8,true)!==source.length)
    return fail("Unsupported GLB 2.0 header.");
  let offset=12;const chunks:{kind:number;data:Uint8Array}[]=[];
  while(offset<source.length){
    if(offset+8>source.length)return fail("Truncated GLB chunk.");
    const length=view.getUint32(offset,true),kind=view.getUint32(offset+4,true);offset+=8;
    if(length%4||length>source.length-offset)return fail("Invalid GLB chunk length.");
    chunks.push({kind,data:source.subarray(offset,offset+length)});offset+=length;
  }
  if(chunks.length!==2||chunks[0]!.kind!==JSON_CHUNK||chunks[1]!.kind!==BIN_CHUNK)
    return fail("Static rebake requires exactly one JSON and one BIN chunk.");
  let doc:GlbDocument;
  try{doc=JSON.parse(dec.decode(chunks[0]!.data).replace(/[\u0000\s]+$/g,"")) as GlbDocument;}
  catch{return fail("Invalid GLB JSON.");}
  if(!doc||doc.asset?.version!=="2.0"||!Array.isArray(doc.buffers)||doc.buffers.length!==1||doc.buffers[0]!.uri||
     !Array.isArray(doc.accessors)||!Array.isArray(doc.bufferViews)||!Array.isArray(doc.meshes)||
     !Array.isArray(doc.nodes)||!Array.isArray(doc.scenes))return fail("Unsupported GLB record structure.");
  const declared=doc.buffers[0]!.byteLength;
  if(!Number.isInteger(declared)||declared<0||declared>chunks[1]!.data.length)return fail("Invalid GLB buffer length.");
  return {doc,binary:chunks[1]!.data.subarray(0,declared)};
}
const elementSize=(componentType:number):number=>({5121:1,5123:2,5125:4,5126:4})[componentType as 5121]??0;
function accessor(doc:GlbDocument,binary:Uint8Array,index:number,components:3|4|1,type:number):{
  length:number;read:(vertex:number,component:number)=>number;source:GlbAccessor;
}{
  const entry=doc.accessors[checkedIndex(index,doc.accessors.length,"accessor")]!;
  const view=doc.bufferViews[checkedIndex(entry.bufferView,doc.bufferViews.length,"bufferView")]!;
  const size=elementSize(type),count=entry.count;
  if(!size||entry.type!==(components===1?"SCALAR":"VEC"+components)||
      entry.componentType!==type||!Number.isInteger(count)||count<=0||count>MAX_VERTICES||
      entry.sparse!==undefined||entry.normalized===true||view.byteStride!==undefined||
      (view.buffer??0)!==0||!Number.isInteger(view.byteLength)||!Number.isInteger(view.byteOffset??0)||
      !Number.isInteger(entry.byteOffset??0))return fail("Static rebake requires packed numeric accessors.");
  const start=(view.byteOffset??0)+(entry.byteOffset??0),end=start+count*size*components;
  if(start<0||start%size||end>binary.byteLength||end>(view.byteOffset??0)+view.byteLength)
    return fail("GLB accessor exceeds its bufferView.");
  const dv=new DataView(binary.buffer,binary.byteOffset,binary.byteLength);
  const read=(v:number,c:number)=>{
    const pos=start+(v*components+c)*size;
    if(type===5126)return dv.getFloat32(pos,true);
    if(type===5125)return dv.getUint32(pos,true);
    if(type===5123)return dv.getUint16(pos,true);
    return dv.getUint8(pos);
  };
  return {length:count,read,source:entry};
}
function writeGlb(doc:GlbDocument,binary:Uint8Array):Uint8Array{
  doc.buffers[0]!.byteLength=binary.length;
  const json=enc.encode(JSON.stringify(doc));
  const jsonSize=(json.length+3)&~3,binSize=(binary.length+3)&~3,total=12+8+jsonSize+8+binSize;
  if(total>MAX_FILE)return fail("Regenerated GLB exceeds safe file budget.");
  const out=new Uint8Array(total);const dv=new DataView(out.buffer);
  dv.setUint32(0,MAGIC,true);dv.setUint32(4,2,true);dv.setUint32(8,total,true);
  dv.setUint32(12,jsonSize,true);dv.setUint32(16,JSON_CHUNK,true);
  out.fill(32,20,20+jsonSize);out.set(json,20);
  dv.setUint32(20+jsonSize,binSize,true);dv.setUint32(24+jsonSize,BIN_CHUNK,true);
  out.set(binary,28+jsonSize);
  return out;
}
/** Regenerate only verified mesh parts. Canonical IFC never comes from GLB. */
export async function rebakeStaticGlb(
  source:Uint8Array,
  manifest:SceneProvenance & {scene:{canonicalToScene?:readonly number[]};nodes:readonly {nodeKey?:string;canonicalId:string;ifcGlobalId?:string}[]},
  placements:readonly ScenePlacementOverride[],
):Promise<BrowserGlbRebake>{
  const sourceSha256=await sha256Bytes(source);
  if(sourceSha256!==manifest.scene.assetSha256)return fail("Source GLB SHA-256 mismatch.");
  const {doc,binary:sourceBinary}=parseGlb(source);
  if(doc.animations||doc.skins||doc.extensionsUsed?.some(ext=>["KHR_draco_mesh_compression","EXT_meshopt_compression","KHR_mesh_quantization"].includes(ext)))
    return fail("Animations, skinning and compressed/quantized geometry require separate conversion.");
  const C=manifest.scene.canonicalToScene;
  const expectedC=[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1];
  if(!C||C.length!==16||C.some((v,i)=>Math.abs(v-expectedC[i]!)>1e-7))return fail("Unsupported canonical-to-glTF frame.");
  const inverseC=invAffine(C);
  const {frames,reachable}=nodeFrames(doc);
  const manifestNodes=new Map<string,string>();
  for(const node of manifest.nodes){
    if(!node.nodeKey||manifestNodes.has(node.nodeKey))return fail("Ambiguous scene node identity.");
    manifestNodes.set(node.nodeKey,JSON.stringify([node.canonicalId,node.ifcGlobalId]));
  }
  const deltas=new Map<string,Matrix4>();
  for(const placement of placements){
    const identity=JSON.stringify([placement.canonicalId,placement.ifcGlobalId]);
    if(deltas.has(identity)||!manifest.nodes.some(n=>n.canonicalId===placement.canonicalId&&n.ifcGlobalId===placement.ifcGlobalId))
      return fail("Missing or duplicate IFC scene identity.");
    const delta=placement.matrix;
    invAffine(delta);
    deltas.set(identity,product(product(C,delta),inverseC));
  }
  if(!deltas.size)return fail("No IFC geometry changes are eligible for regeneration.");
  // Preserve source buffer bytes exactly; newly generated streams never share storage.
  const docCopy=structuredClone(doc);
  // Chunks avoid constructing 50+ MiB JS number arrays or spreading millions
  // of vertex bytes onto the call stack. One binary allocation at completion.
  const chunks:Uint8Array[]=[sourceBinary];let binaryLength=sourceBinary.length;
  const append=(values:readonly number[],sourceAccessor:number,components:3|4):number=>{
    const original=doc.accessors[sourceAccessor]!;
    const pad=(4-binaryLength%4)%4;
    if(pad){chunks.push(new Uint8Array(pad));binaryLength+=pad;}
    const start=binaryLength,newData=new Uint8Array(values.length*4),writer=new DataView(newData.buffer);
    const minimum=Array<number>(components).fill(Infinity),maximum=Array<number>(components).fill(-Infinity);
    for(let i=0;i<values.length;i++){
      const value=values[i]!;
      if(!finite(value)||Math.abs(value)>1e7)return fail("Nonfinite or oversized regenerated vertex attribute.");
      writer.setFloat32(i*4,value,true);
      // glTF accessor bounds must enclose the actual stored float32 values,
      // not pre-rounding float64 geometry produced by matrix composition.
      const stored=writer.getFloat32(i*4,true);
      minimum[i%components]=Math.min(minimum[i%components]!,stored);
      maximum[i%components]=Math.max(maximum[i%components]!,stored);
    }
    binaryLength+=newData.length;
    if(binaryLength>MAX_FILE)return fail("Geometry rebake exceeded the binary memory budget.");
    chunks.push(newData);
    const viewIndex=docCopy.bufferViews.length;
    docCopy.bufferViews.push({buffer:0,byteOffset:start,byteLength:newData.length,target:34962});
    const next:GlbAccessor={...structuredClone(original),bufferView:viewIndex,byteOffset:0};
    delete next.min;delete next.max;
    if(components===3&&original.type==="VEC3"){next.min=minimum;next.max=maximum;}
    docCopy.accessors.push(next);
    return docCopy.accessors.length-1;
  };
  const found=new Set<string>();let triangleCount=0;
  for(let nodeIndex=0;nodeIndex<docCopy.nodes.length;nodeIndex++){
    const node=docCopy.nodes[nodeIndex]!;
    const tag=node.extras?.teldra, identity=JSON.stringify([tag?.canonicalId,tag?.ifcGlobalId]);
    const globalDelta=deltas.get(identity);
    if(!globalDelta)continue;
    if(!reachable.has(nodeIndex)||!tag?.nodeKey||manifestNodes.get(tag.nodeKey)!==identity)
      return fail("GLB part identity is absent, mismatched or unreachable.");
    if(node.skin!==undefined||node.weights!==undefined||node.extensions!==undefined)
      return fail("Skinned, instanced or morphable nodes are unsupported.");
    const meshIndex=checkedIndex(node.mesh,doc.meshes.length,"selected mesh");
    const sourceMesh=doc.meshes[meshIndex]!;
    if(sourceMesh.weights||!Array.isArray(sourceMesh.primitives)||!sourceMesh.primitives.length)
      return fail("Selected source mesh has unsupported geometry.");
    const localDelta=product(product(invAffine(frames[nodeIndex]!),globalDelta),frames[nodeIndex]!);
    const inverseLocal=invAffine(localDelta);
    const newMesh=structuredClone(sourceMesh);
    for(const primitive of newMesh.primitives){
      if((primitive.mode??4)!==4||primitive.targets||primitive.extensions)return fail("Only static indexed triangles can rebake.");
      const attrs=primitive.attributes;
      if(!attrs||!Number.isInteger(attrs.POSITION)||Object.keys(attrs).some(key=>key.startsWith("JOINTS_")||key.startsWith("WEIGHTS_")))
        return fail("Selected primitive requires static POSITION geometry.");
      const position=accessor(doc,sourceBinary,attrs.POSITION!,3,5126);
      const indexId=checkedIndex(primitive.indices,doc.accessors.length,"triangle indices");
      const indexType=doc.accessors[indexId]!.componentType;
      if(![5121,5123,5125].includes(indexType))return fail("Unsupported triangle index component.");
      const indices=accessor(doc,sourceBinary,indexId,1,indexType);
      if(indices.length%3)return fail("Nontriangular index count.");
      for(let i=0;i<indices.length;i++)if(indices.read(i,0)>=position.length)return fail("Out-of-range triangle index.");
      const shifted:number[]=[];
      for(let i=0;i<position.length;i++)shifted.push(...transform(localDelta,position.read(i,0),position.read(i,1),position.read(i,2),true));
      attrs.POSITION=append(shifted,attrs.POSITION!,3);
      let normals:number[]|undefined;
      if(attrs.NORMAL!==undefined){
        const n=accessor(doc,sourceBinary,attrs.NORMAL,3,5126);
        if(n.length!==position.length)return fail("Normal and position counts differ.");
        normals=[];
        for(let i=0;i<n.length;i++){
          const x=n.read(i,0),y=n.read(i,1),z=n.read(i,2);
          normals.push(...normalize([inverseLocal[0]!*x+inverseLocal[1]!*y+inverseLocal[2]!*z,
            inverseLocal[4]!*x+inverseLocal[5]!*y+inverseLocal[6]!*z,
            inverseLocal[8]!*x+inverseLocal[9]!*y+inverseLocal[10]!*z]));
        }
        attrs.NORMAL=append(normals,attrs.NORMAL,3);
      }
      if(attrs.TANGENT!==undefined){
        if(!normals)return fail("Tangent accessor without normals.");
        const t=accessor(doc,sourceBinary,attrs.TANGENT,4,5126);
        if(t.length!==position.length)return fail("Tangent/position vertex counts differ.");
        const tangents:number[]=[];
        for(let i=0;i<t.length;i++){
          const handed=t.read(i,3);
          if(Math.abs(Math.abs(handed)-1)>1e-5)return fail("Invalid tangent handedness.");
          const rotated=transform(localDelta,t.read(i,0),t.read(i,1),t.read(i,2),false);
          const normal=normals.slice(i*3,i*3+3),dot=normal.reduce((sum,n,j)=>sum+n*rotated[j]!,0);
          const xyz=normalize(rotated.map((v,j)=>v-dot*normal[j]!));
          tangents.push(...xyz,handed);
        }
        attrs.TANGENT=append(tangents,attrs.TANGENT,4);
      }
      triangleCount+=indices.length/3;
    }
    node.mesh=docCopy.meshes.length;docCopy.meshes.push(newMesh);found.add(identity);
  }
  if(found.size!==deltas.size)return fail("Not all changed IFC objects map to GLB geometry.");
  const binary=new Uint8Array(binaryLength);
  let offset=0;
  for(const chunk of chunks){binary.set(chunk,offset);offset+=chunk.length;}
  const result=writeGlb(docCopy,binary);
  return {bytes:result,sourceSha256,bakedSha256:await sha256Bytes(result),
    triangleCount,editedObjectCount:found.size};
}
