import {mkdir,readFile,rm} from "node:fs/promises";
import {spawn,spawnSync} from "node:child_process";
import {createServer} from "node:net";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {assertCompleteRendererRun} from "./webgpu-execution-report.mjs";

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const studioRoot=path.join(repositoryRoot,"apps/studio");
const reportPath=path.join(studioRoot,"test-results/renderer-webgpu-certification.json");
function git(args) {
 const result=spawnSync("git",args,{cwd:repositoryRoot,encoding:"utf8"});
 if(result.status!==0)throw new Error("Cannot identify renderer source checkout");
 return result.stdout.trim();
}
function run(args,env=process.env) {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{cwd:studioRoot,stdio:"inherit",env});
  child.once("error",reject);child.once("exit",(code)=>resolve(code??1));
 });
}
async function freePort() {
 const server=createServer();
 await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
 const port=server.address().port;
 await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 return port;
}
async function main() {
 await mkdir(path.dirname(reportPath),{recursive:true});await rm(reportPath,{force:true});
 const revision=git(["rev-parse","HEAD"]),dirty=git(["status","--porcelain"])?"1":"0";
 const unitCode=await run(["--test",path.join(repositoryRoot,"tools/quality/webgpu-execution-report.test.mjs")]);
 if(unitCode)return unitCode;
 const storybookRoot=path.join(studioRoot,"node_modules/storybook");
 const manifest=JSON.parse(await readFile(path.join(storybookRoot,"package.json"),"utf8"));
 const binary=typeof manifest.bin==="string"?manifest.bin:manifest.bin.storybook;
 const buildCode=await run([path.resolve(storybookRoot,binary),"build","--output-dir","test-results/webgpu-storybook"]);
 if(buildCode)return buildCode;
 if(git(["rev-parse","HEAD"])!==revision)throw new Error("Source revision changed during renderer build");
 const port=await freePort();
 const code=await run([path.join(studioRoot,"node_modules/@playwright/test/cli.js"),"test",
  "test/storybook/webgpu-mipmaps.spec.ts","test/storybook/gpu-floor-probe.spec.ts",
  "test/storybook/webgpu-frame-lifecycle.spec.ts","--reporter=line,json"],{
   ...process.env,TELDRA_REQUIRE_WEBGPU:"1",TELDRA_RENDERER_PORT:String(port),
   TELDRA_RENDERER_SOURCE_COMMIT:revision,TELDRA_RENDERER_WORKTREE_DIRTY:dirty,
   TELDRA_RENDERER_FRESH_BUNDLE:"1",PLAYWRIGHT_JSON_OUTPUT_FILE:reportPath,
  });
 if(code)return code;
 const report=JSON.parse(await readFile(reportPath,"utf8"));
 assertCompleteRendererRun(report,revision);
 console.log(`WebGPU execution passed: ${path.relative(repositoryRoot,reportPath)}`);
 return 0;
}
try {process.exitCode=await main();}
catch(error){console.error(`WebGPU execution failed: ${error.message}`);process.exitCode=1;}
