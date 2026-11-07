import {readFile,writeFile,mkdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const manifest=JSON.parse(await readFile(resolve(root,"examples/21d-sweethome3d/demo-manifest.json"),"utf8"));
const bytes=await readFile(resolve(root,"examples/21d-sweethome3d",manifest.file));
if(bytes.length!==manifest.bytes || createHash("sha256").update(bytes).digest("hex")!==manifest.sha256)
  throw new Error("The complete 21D demo is missing or changed. Run git lfs pull before building Studio.");
const target=resolve(root,"apps/studio/public");await mkdir(target,{recursive:true});
await writeFile(resolve(target,"21D.teldra"),bytes);
await writeFile(resolve(target,"21D.manifest.json"),JSON.stringify(manifest,null,2));
console.log(`Prepared verified real-home demo: ${(bytes.length/1048576).toFixed(1)} MiB`);
