import {expect,test,type Page} from "@playwright/test";

async function screenshotPixel(page:Page,x:number,y:number):Promise<number[]> {
 const png=(await page.getByTestId("twin-canvas").screenshot()).toString("base64");
 return page.evaluate(async({png,x,y})=>{
  const image=await createImageBitmap(new Blob([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],{type:"image/png"}));
  const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;
  const context=canvas.getContext("2d")!;context.drawImage(image,0,0);image.close();
  return [...context.getImageData(Math.floor(x),Math.floor(y),1,1).data].slice(0,3);
 },{png,x,y});
}

for(const backend of ["webgl","webgpu"] as const)test(`GPU probe matches asymmetric rendered pixels and tapped UV on ${backend}`,async({page})=>{
 await page.addInitScript(()=>Object.defineProperty(navigator,"clipboard",{value:{writeText:async(value:string)=>{Object.assign(window,{lastGpuReport:value});}}}));
 await page.goto(`/iframe.html?id=studio-sh3d-visual-transport--asymmetric-gpu-probe&viewMode=story${backend==="webgl"?"&renderer=webgl":""}`);
 await expect(page.getByTestId("viewport-status")).toHaveText("ready");
 test.skip(backend==="webgpu"&&await page.locator(".teldra-twin-viewport").getAttribute("data-backend")!=="webgpu","WebGPU adapter unavailable");
 await page.getByRole("button",{name:"Top",exact:true}).click();
 await page.getByText("Appearance",{exact:true}).click();
 await page.getByRole("button",{name:"Restore source appearance",exact:true}).click();
 await page.getByLabel("Inspect floor textures without lighting",{exact:true}).check();
 await page.getByText("Appearance",{exact:true}).click();
 const canvas=(await page.getByTestId("twin-canvas").boundingBox())!;
 const colors:number[][]=[];
 for(const fraction of [0.42,0.58]) {
  const x=Math.floor(canvas.width*0.55),y=Math.floor(canvas.height*fraction);
  const expected=await screenshotPixel(page,x,y);colors.push(expected);
  await page.getByText("Appearance",{exact:true}).click();
  await page.getByRole("button",{name:"Identify visible surface",exact:true}).click();
  await page.getByText("Appearance",{exact:true}).click();
  await page.mouse.click(canvas.x+x,canvas.y+y);
  await page.getByText("Appearance",{exact:true}).click();
  await expect(page.getByRole("button",{name:"Copy GPU diagnostic report",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"Copy GPU diagnostic report",exact:true}).click();
  const report=JSON.parse(await page.evaluate(()=>(window as unknown as {lastGpuReport:string}).lastGpuReport)) as {
   framebufferRgb:number[];surface:{uv:number[];canonicalId:string};mips:{level:number;rgb:number[];sampleLocation:string}[];
   capture:{backend:string;floorMinification:string;declaredSceneSha256:string};
  };
  await test.info().attach(`probe-${backend}-${fraction}`,{body:JSON.stringify({expected,report}),contentType:"application/json"});
  expect(report.capture.backend).toBe(backend);
  expect(report.capture.floorMinification).toBe("auto");
  expect(report.capture.declaredSceneSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(report.surface.canonicalId).toBe("sh3d:room:room-probe");
  expect(report.surface.uv).toHaveLength(2);
  expect(report.mips.map(m=>m.level)).toEqual([0,2,4]);
  expect(report.mips[0]!.sampleLocation).toBe("picked UV");
  for(let channel=0;channel<3;channel++) {
   expect(Math.abs(report.framebufferRgb[channel]!-expected[channel]!)).toBeLessThanOrEqual(3);
   expect(Math.abs(report.mips[0]!.rgb[channel]!-expected[channel]!)).toBeLessThanOrEqual(3);
  }
  await page.getByText("Appearance",{exact:true}).click();
 }
 expect(colors[0]).not.toEqual(colors[1]);
});
