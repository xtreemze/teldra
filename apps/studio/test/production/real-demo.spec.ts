import {expect,test} from "@playwright/test";

test("real Sweet Home 3D demo opens automatically with ready maps and viewport panels",async({page},testInfo)=>{
 test.setTimeout(180000);
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("./");
 await expect(page.getByTestId("viewport-status")).toHaveText("ready",{timeout:150000});
 const assets=JSON.parse((await page.getByTestId("asset-summary").textContent())!);
 expect(assets).toMatchObject({meshParts:9512,visibleMeshParts:4488,hiddenSourceParts:5022,sourcePhongMaterials:467,textures:253,texturesReady:true,localLightSources:22,lightingProfile:"sh3d-preview-v1"});
 // These are material bindings after runtime source-Phong projection, not just GLB inputs.
 console.log("21D floor runtime texture bindings", JSON.stringify({
  roomTexturedParts:assets.roomTexturedParts,
  roomTexturesBound:assets.roomTexturesBound,
  roomTexturesReady:assets.roomTexturesReady,
 }));
 expect(assets.roomTexturedParts).toBe(13);
 expect(assets.roomTexturesBound).toBe(13);
 expect(assets.roomTexturesReady).toBe(13);
 const canvas=(await page.getByTestId("twin-canvas").boundingBox())!;
 expect(canvas.width).toBeGreaterThan(1400); expect(canvas.height).toBeGreaterThan(900);
 for(const role of ["Project actions","Camera controls","3D orientation gizmo"]){
  const box=(await page.getByRole("group",{name:role,exact:true}).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(canvas.x);expect(box.y).toBeGreaterThanOrEqual(canvas.y);
  expect(box.x+box.width).toBeLessThanOrEqual(canvas.x+canvas.width+1);
 }
 await page.getByText("Appearance",{exact:true}).click();
 expect(assets.floorInspectionMaterials).toBeGreaterThan(0);
 const floorToggle=page.getByLabel("Inspect floor textures without lighting",{exact:true});
 await floorToggle.check();
 await expect(floorToggle).toBeChecked();
 await floorToggle.uncheck();
 await expect(floorToggle).not.toBeChecked();
 await page.getByLabel("Textures and diffuse maps",{exact:true}).uncheck();
 await expect(page.getByLabel("Textures and diffuse maps",{exact:true})).not.toBeChecked();
 await page.getByRole("button",{name:"Restore source appearance",exact:true}).click();
 await expect(page.getByLabel("Textures and diffuse maps",{exact:true})).toBeChecked();
 await page.getByText("Appearance",{exact:true}).click();
 // Exercise real pointer delivery and picking in the full-size home. The
 // imported geometry is irregular, so sample the visible central scene.
 await page.getByRole("button",{name:"Scene",exact:true}).click();
 let picked: string | null = null;
 for (const y of [.35,.45,.55,.65,.75]) {
  for (const x of [.35,.45,.55,.65,.75]) {
   const px=canvas.x+canvas.width*x, py=canvas.y+canvas.height*y;
   if (!await page.evaluate(({px,py})=>document.elementFromPoint(px,py)?.matches('[data-testid="twin-canvas"]'),{px,py})) continue;
   await page.mouse.click(px,py);
   const id=await page.getByTestId("selected-canonical-id").textContent();
   if (id && id!=="none" && id!=="unattempted") { picked=id; break; }
  }
  if (picked) break;
 }
 expect(picked).not.toBeNull();
 await expect(page.getByTestId("workspace-selected-canonical-id")).toHaveText(picked!);
 await page.screenshot({path:testInfo.outputPath("real-home-desktop.png")});
 expect(errors).toEqual([]);
});

test("real Sweet Home 3D demo mobile view opens with scene and appearance controls",async({page},testInfo)=>{
 test.setTimeout(180000);
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 await page.setViewportSize({width:390,height:844});
 await page.goto("./");
 await expect(page.getByTestId("viewport-status")).toHaveText("ready",{timeout:150000});
 await expect(page.getByRole("button",{name:"Scene",exact:true})).toHaveAttribute("aria-expanded","false");
 await page.getByRole("button",{name:"Scene",exact:true}).click();
 await expect(page.getByLabel("Search scene",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Scene",exact:true}).click();
 await expect(page.getByRole("button",{name:"Scene",exact:true})).toHaveAttribute("aria-expanded","false");
 await page.getByRole("button",{name:"View",exact:true}).click();
 const view=page.getByRole("group",{name:"Mobile view settings"});
 await expect(view.getByRole("button",{name:"Top",exact:true})).toBeVisible();
 await view.getByText("Layers",{exact:true}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 const mobileCanvas=(await page.getByTestId("twin-canvas").boundingBox())!;
 const viewButton=(await page.getByRole("button",{name:"View",exact:true}).boundingBox())!;
 const visibility=(await page.getByText("Show hidden source content",{exact:true}).boundingBox())!;
 expect(viewButton.x).toBeGreaterThanOrEqual(mobileCanvas.x);
 expect(viewButton.x+viewButton.width).toBeLessThanOrEqual(mobileCanvas.x+mobileCanvas.width+1);
 expect(visibility.x+visibility.width).toBeLessThanOrEqual(mobileCanvas.x+mobileCanvas.width+1);
 await page.screenshot({path:testInfo.outputPath("real-home-mobile.png")});
 expect(errors).toEqual([]);
});
