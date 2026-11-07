import {expect,test} from "@playwright/test";

test("real Sweet Home 3D demo opens automatically with ready maps and viewport panels",async({page},testInfo)=>{
 test.setTimeout(180000);
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("./");
 await expect(page.getByTestId("viewport-status")).toHaveText("ready",{timeout:150000});
 const assets=JSON.parse((await page.getByTestId("asset-summary").textContent())!);
 expect(assets).toMatchObject({meshParts:9512,visibleMeshParts:4488,hiddenSourceParts:5022,sourcePhongMaterials:467,textures:253,texturesReady:true,lightingProfile:"sh3d-preview-v1"});
 const canvas=(await page.getByTestId("twin-canvas").boundingBox())!;
 expect(canvas.width).toBeGreaterThan(1400); expect(canvas.height).toBeGreaterThan(900);
 for(const role of ["Project actions","Camera controls","3D orientation gizmo"]){
  const box=(await page.getByRole("group",{name:role,exact:true}).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(canvas.x);expect(box.y).toBeGreaterThanOrEqual(canvas.y);
  expect(box.x+box.width).toBeLessThanOrEqual(canvas.x+canvas.width+1);
 }
 await page.getByText("Appearance",{exact:true}).click();
 await page.getByLabel("Textures and diffuse maps",{exact:true}).uncheck();
 await expect(page.getByLabel("Textures and diffuse maps",{exact:true})).not.toBeChecked();
 await page.getByRole("button",{name:"Restore source appearance",exact:true}).click();
 await expect(page.getByLabel("Textures and diffuse maps",{exact:true})).toBeChecked();
 await page.getByText("Appearance",{exact:true}).click();
 await page.screenshot({path:testInfo.outputPath("real-home-desktop.png")});
 await page.setViewportSize({width:390,height:844});await page.reload();
 await expect(page.getByTestId("viewport-status")).toHaveText("ready",{timeout:150000});
 await expect(page.getByRole("button",{name:"Scene",exact:true})).toHaveAttribute("aria-expanded","false");
 await page.getByRole("button",{name:"Scene",exact:true}).click();
 await expect(page.getByLabel("Search scene",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Inspector",exact:true}).click();
 await expect(page.getByRole("button",{name:"Scene",exact:true})).toHaveAttribute("aria-expanded","false");
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 const gizmo=(await page.getByRole("group",{name:"3D orientation gizmo",exact:true}).boundingBox())!;
 const visibility=(await page.getByText("Show hidden source content",{exact:true}).boundingBox())!;
 expect(visibility.x+visibility.width).toBeLessThanOrEqual(gizmo.x);
 await page.screenshot({path:testInfo.outputPath("real-home-mobile.png")});
 expect(errors).toEqual([]);
});
