import { expect, test, type Page } from "@playwright/test";

async function centerPixel(page: Page): Promise<number[]> {
  const png = (await page.getByTestId("twin-canvas").screenshot()).toString("base64");
  return page.evaluate(async png => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], {type:"image/png"}));
    const canvas = document.createElement("canvas"); canvas.width=bitmap.width; canvas.height=bitmap.height;
    const context=canvas.getContext("2d")!; context.drawImage(bitmap,0,0); bitmap.close();
    return [...context.getImageData(Math.floor(canvas.width/2)+12,Math.floor(canvas.height/2)+12,1,1).data].slice(0,3);
  }, png);
}

test("dark source albedo survives glTF to Phong transfer and mip minification", async ({page}) => {
  const errors:string[]=[]; page.on("pageerror", e=>errors.push(e.message));
  await page.goto("/iframe.html?id=studio-sh3d-visual-transport--dark-floor-color-transfer&viewMode=story&renderer=webgl");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await page.getByRole("button",{name:"Top",exact:true}).click();
  await page.getByText("Appearance",{exact:true}).click();
  await page.getByRole("button",{name:"Restore source appearance",exact:true}).click();
  await page.getByLabel("Inspect floor textures without lighting",{exact:true}).check();
  const expected=[42,56,62];
  for(let distance=0;distance<2;distance++) {
    await expect.poll(async()=> (await centerPixel(page)).map((v,i)=>Math.abs(v-expected[i]!)).every(v=>v<=3)).toBe(true);
    await test.info().attach(`floor-distance-${distance}`, {path:await (async()=>{const path=test.info().outputPath(`floor-distance-${distance}.png`); await page.getByTestId("twin-canvas").screenshot({path}); return path;})(),contentType:"image/png"});
    if(distance===0) for(let i=0;i<4;i++) await page.getByRole("button",{name:"Zoom out",exact:true}).click();
  }
  await page.getByLabel("Inspect floor textures without lighting",{exact:true}).uncheck();
  const lit=await centerPixel(page);
  console.info("source floor pixels", JSON.stringify({expected,lit}));
  await test.info().attach("pixel-evidence",{body:JSON.stringify({expected,lit}),contentType:"application/json"});
  expect(lit.every((v,i)=>v>=expected[i]!-3)).toBe(true);
  expect(errors).toEqual([]);
});


test("appearance defaults and reset keep automatic floor sampling on desktop and mobile",async({page})=>{
 await page.goto("/iframe.html?id=studio-sh3d-visual-transport--dark-floor-color-transfer&viewMode=story");
 await expect(page.getByTestId("viewport-status")).toHaveText("ready");
 await page.getByText("Appearance",{exact:true}).click();
 const desktop=page.getByLabel("Floor texture minification",{exact:true});
 await expect(desktop).toHaveValue("auto");
 await desktop.selectOption("source");
 await page.getByRole("button",{name:"Restore source appearance",exact:true}).click();
 await expect(desktop).toHaveValue("auto");
 await page.getByText("Appearance",{exact:true}).click();
 await page.setViewportSize({width:390,height:844});
 await page.getByRole("button",{name:"View",exact:true}).click();
 const view=page.getByRole("group",{name:"Mobile view settings"});
 await view.getByText("Appearance",{exact:true}).click();
 const mobile=page.getByLabel("Mobile floor texture minification",{exact:true});
 await expect(mobile).toHaveValue("auto");
 await mobile.selectOption("anisotropic");
 await view.getByRole("button",{name:"Restore source appearance",exact:true}).click();
 await expect(mobile).toHaveValue("auto");
});
