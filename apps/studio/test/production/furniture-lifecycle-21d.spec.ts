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
 await page.goto("./");
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
  await page.getByRole("button",{name:"Undo",exact:true}).click();
  await expect(objects.getByRole("button")).toHaveCount(originalCount+1);
  await page.getByRole("button",{name:"Redo",exact:true}).click();
  await expect(objects.getByRole("button")).toHaveCount(originalCount);
  await page.getByRole("button",{name:"Undo",exact:true}).click();
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
 await copy.click();
 await tools.getByRole("button",{name:"Move",exact:true}).click();
 expect(Number(await page.getByLabel("Position X (m)",{exact:true}).inputValue())).toBeCloseTo(startX+1,3);
 await page.keyboard.press("Escape");
 expect(errors).toEqual([]);
});
