import { readFile, writeFile } from "node:fs/promises";
import { brotliCompressSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = resolve(root,"apps/studio/dist");
const manifest = JSON.parse(await readFile(resolve(dist,".vite/manifest.json"),"utf8"));
const budget = JSON.parse(await readFile(resolve(root,"quality/budgets.json"),"utf8"));
const initial = new Set();
function visit(key) { if (initial.has(key)) return; initial.add(key); for(const value of manifest[key]?.imports ?? []) visit(value); }
for(const [key,value] of Object.entries(manifest)) if(value.isEntry) visit(key);
const shellFiles = new Set([...initial].map(key=>manifest[key].file));
const cssFiles = new Set([...initial].flatMap(key=>manifest[key].css??[]));
const size = async files => { let bytes=0; for(const file of files) bytes += brotliCompressSync(await readFile(resolve(dist,file))).byteLength; return bytes/1024; };
const metrics = {initialShellBrotliKiB: await size(shellFiles), initialCssBrotliKiB: await size(cssFiles), sourceCommit: process.env.GITHUB_SHA ?? null,
  note: "Actual Brotli-compressed initial static import graph; lazy 3D and IFC/WASM chunks excluded."};
for(const key of ["initialShellBrotliKiB","initialCssBrotliKiB"]) if(metrics[key] > budget.assetBudgets[key]) throw new Error(`${key} ${metrics[key].toFixed(1)} exceeds ${budget.assetBudgets[key]}`);
await writeFile(resolve(dist,"build-metrics.json"),JSON.stringify(metrics,null,2));
console.log(JSON.stringify(metrics));
