import {expect,test} from "@playwright/test";

// Integrated check on the real 21D Sweet Home 3D project (git lfs pull examples/21d-sweethome3d), not a fixture.
test("21D: duplicate, move, delete, undo/redo, save and reopen real furniture without touching its siblings",async({page},testInfo)=>{
 test.setTimeout(420000);
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 // Phase timings go to the CI log so a slow phase is visible without a trace.
 const phase=async<T>(name:string,body:()=>Promise<T>):Promise<T>=>test.step(name,async()=>{
  const start=Date.now();
  try{return await body()}
  finally{const line=`21D phase ${name}: ${Date.now()-start} ms`;console.log(line)}
 });
 await phase("open",async()=>{
  page.on("console",m=>{if(m.text().startsWith("[tt]"))console.log(m.text())});
 await page.goto("./?e2e=1");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready",{timeout:150000});
 });
 const objects=page.getByRole("list",{name:"Building objects",exact:true});
 const furniture=objects.getByRole("button",{name:/ furniture$/});
 const total=await furniture.count();
 expect(total).toBeGreaterThan(3);
 const originalCount=await objects.getByRole("button").count();
 const target=furniture.first();
 const label=(await target.locator("span").first().textContent())!.trim();
 await target.click();
 const tools=page.getByRole("toolbar",{name:"Transform tools",exact:true});
 await expect(tools.getByRole("button",{name:"Duplicate",exact:true})).toBeEnabled();
 await page.getByTestId("twin-canvas").focus();
 await page.keyboard.press("Shift+D");
 const copy=objects.getByRole("button",{name:new RegExp("^"+label.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+" \\(copy\\) furniture$")});
 await phase("duplicate",async()=>{
  await expect(copy).toBeVisible({timeout:180000});
  await expect(copy).toHaveAttribute("aria-pressed","true");
  await expect(objects.getByRole("button")).toHaveCount(originalCount+1);
 });
 const sync=page.getByTestId("scene-sync");
 const settled=async()=>{await expect(sync).toHaveAttribute("data-state","in-sync",{timeout:60000});
  await expect.poll(async()=>(await sync.getAttribute("data-model-revision"))===(await sync.getAttribute("data-rendered-revision")),{timeout:60000}).toBe(true);};
 // Frame the element with only furniture layers shown (so nothing occludes it), then count screen samples whose pick
 // resolves to its canonical identity: the mesh exists, is visible and pickable.
 const probe=(canonicalId:string)=>page.evaluate((id)=>{
  const e2e=(window as any).__teldraE2E,v=e2e.viewport;const ref=e2e.controller.twin.building.refs.find((r:any)=>r.id===id);
  if(!ref)return {ref:false,hits:0};
  const layers=v.layers().filter((l:any)=>l.group==="category"&&l.id!=="category:Furniture"&&l.visible);
  for(const l of layers)v.setLayerVisible(l.id,false);
  v.fit(id);
  return new Promise<{ref:boolean;hits:number}>(resolve=>setTimeout(()=>{ // let the camera finish framing
   const r=document.querySelector("[data-testid='twin-canvas']")!.getBoundingClientRect();let hits=0;
   for(let i=0;i<60;i++)for(let j=0;j<60;j++)if(v.pick(r.left+r.width/2+(i-30)*5,r.top+r.height/2+(j-30)*5)?.canonicalId===id)hits++;
   for(const l of layers)v.setLayerVisible(l.id,true);
   resolve({ref:true,hits});},1500));
 },canonicalId);
 await settled();
 const copyId=(await page.getByTestId("workspace-selected-canonical-id").textContent())!.trim();
 const born=await probe(copyId);
 console.log("21D copy mesh probe",JSON.stringify(born));
 expect(born.hits).toBeGreaterThan(0);
 const x=page.getByLabel("Position X (m)",{exact:true});
 const startX=Number(await x.inputValue());
 await phase("move",async()=>{
  await x.fill(String(startX+1));
  await page.getByRole("button",{name:"Apply placement",exact:true}).click();
  await expect(page.getByRole("button",{name:"Save project",exact:true})).toBeEnabled();
 });
 // Delete the original; undo; redo.
 await phase("delete-undo-redo",async()=>{
  await target.click();
  await tools.getByRole("button",{name:"Delete",exact:true}).click();
  await page.getByRole("alertdialog",{name:"Confirm delete"}).getByRole("button",{name:/^Delete /}).click();
  await expect(objects.getByRole("button")).toHaveCount(originalCount);
  await settled();
  await page.getByRole("button",{name:"Undo",exact:true}).click();
  await expect(objects.getByRole("button")).toHaveCount(originalCount+1);
  await settled();
  await page.getByRole("button",{name:"Redo",exact:true}).click();
  await expect(objects.getByRole("button")).toHaveCount(originalCount);
  await settled();
  await page.getByRole("button",{name:"Undo",exact:true}).click();
  await settled();
 });
 const path=testInfo.outputPath("21d-lifecycle.teldra");
 await phase("save-download",async()=>{
  const pending=page.waitForEvent("download");
  await page.getByRole("button",{name:"Save project",exact:true}).click();
  await (await pending).saveAs(path);
 });
 await page.addInitScript(()=>Object.defineProperty(window,"showOpenFilePicker",{value:undefined,configurable:true}));
 await phase("reload",async()=>{
  await page.reload();
  await expect(page.getByTestId("viewport-status")).toHaveText("ready",{timeout:150000});
 });
 await phase("reopen-read",async()=>{
  const picker=page.waitForEvent("filechooser");await page.getByRole("button",{name:"Open another",exact:true}).click();
  await(await picker).setFiles(path);
  await expect(page.getByTestId("browser-project-file")).toHaveText("21d-lifecycle.teldra",{timeout:240000});
 });
 await phase("reopen-ready",async()=>{
  await expect(page.getByTestId("viewport-status")).toHaveText("ready",{timeout:240000});
  await expect(objects.getByRole("button")).toHaveCount(originalCount+1);
  await expect(copy).toBeVisible();
 });
 await settled();
 // Reopened: the saved copy has no baked mesh, so it was regenerated from IFC and is pickable again.
 await expect.poll(async()=>(await probe(copyId)).hits,{timeout:60000}).toBeGreaterThan(0);
 await copy.click();
 await tools.getByRole("button",{name:"Move",exact:true}).click();
 expect(Number(await page.getByLabel("Position X (m)",{exact:true}).inputValue())).toBeCloseTo(startX+1,3);
 await page.keyboard.press("Escape");
 expect(errors).toEqual([]);
});

const percentile=(values:number[],p:number)=>{const s=[...values].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(p*s.length)-1)]!;};
test("21D: incremental scene regeneration timing (cold and warm, >=10 runs each of duplicate, undo, delete, restore)",async({page})=>{
 test.setTimeout(600000);
 await page.goto("./?e2e=1");
 await expect(page.getByTestId("viewport-status")).toHaveText("ready",{timeout:150000});
 const objects=page.getByRole("list",{name:"Building objects",exact:true});
 await objects.getByRole("button",{name:/ furniture$/}).first().click();
 const targetId=(await page.getByTestId("workspace-selected-canonical-id").textContent())!.trim();
 const report=await page.evaluate(async({id,runs})=>{
  const e=(window as any).__teldraE2E,c=e.controller;
  const now=()=>performance.now();
  const rows:any[]=[];
  await c.prepareFurnitureEditing(id);
  for(let i=0;i<runs;i++){
   const row:any={};
   let t=now();const copy=await c.duplicateFurniture(id);row.dupMutate=now()-t;
   t=now();await c.sceneIdle();row.dupRegen=now()-t;row.dupStages=c.sceneTimings;
   t=now();c.undo();row.undoMutate=now()-t;t=now();await c.sceneIdle();row.undoRegen=now()-t;
   t=now();await c.removeFurniture(id);row.delMutate=now()-t;
   t=now();await c.sceneIdle();row.delRegen=now()-t;
   t=now();c.undo();row.restoreMutate=now()-t;t=now();await c.sceneIdle();row.restoreRegen=now()-t;
   row.inSync=c.sceneSyncStatus.state;row.revs=[c.revision,c.renderedRevision];rows.push(row);
  }
  return rows;
 },{id:targetId,runs:11});
 const keys=["dupMutate","dupRegen","undoMutate","undoRegen","delMutate","delRegen","restoreMutate","restoreRegen"];
 const summary:Record<string,unknown>={cold:report[0]};
 for(const k of keys){const warm=report.slice(1).map((r:any)=>r[k]);summary[k]={medianMs:Math.round(percentile(warm,0.5)),p95Ms:Math.round(percentile(warm,0.95))};}
 console.log("21D TIMING "+JSON.stringify(summary));
 expect(report.every((r:any)=>r.inSync==="in-sync"&&r.revs[0]===r.revs[1])).toBe(true);
});
