import {expect,test} from "@playwright/test";

test("WebGPU initial frame submits source mip generation before the swapchain expires",async({page})=>{
 await page.addInitScript(()=>{
  if(typeof GPUDevice === "undefined")return;
  const state={textures:[] as {texture:GPUTexture;device:GPUDevice}[],errors:[] as string[]};
  Object.assign(window,{teldraGpuTest:state});
  const create=GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture=function(descriptor){
   const texture=create.call(this,descriptor);
   if(descriptor.label?.includes("dark.png")) {
    state.textures.push({texture,device:this});
    this.addEventListener("uncapturederror",event=>state.errors.push(event.error.message));
   }
   return texture;
  };
 });
 await page.goto("/iframe.html?id=studio-sh3d-visual-transport--dark-floor-color-transfer&viewMode=story");
 await expect(page.getByTestId("viewport-status")).toHaveText("ready");
 test.skip(await page.locator(".teldra-twin-viewport").getAttribute("data-backend")!=="webgpu","No WebGPU adapter available; run with a hardware-enabled browser");
 const report=await page.evaluate(async()=>{
  await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  const state=(window as unknown as {teldraGpuTest:{textures:{texture:GPUTexture;device:GPUDevice}[];errors:string[]}}).teldraGpuTest;
  const {texture,device}=state.textures[0]!;
  await device.queue.onSubmittedWorkDone();
  const levels=[];
  for(let level=0;level<texture.mipLevelCount;level++) {
   const buffer=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   const encoder=device.createCommandEncoder();
   encoder.copyTextureToBuffer({texture,mipLevel:level},{buffer,bytesPerRow:256},{width:1,height:1});
   device.queue.submit([encoder.finish()]);
   await buffer.mapAsync(GPUMapMode.READ);
   levels.push([...new Uint8Array(buffer.getMappedRange()).slice(0,4)]);
   buffer.unmap();buffer.destroy();
  }
  return {levels,errors:state.errors};
 });
 await test.info().attach("actual-gpu-mips",{body:JSON.stringify(report),contentType:"application/json"});
 expect(report.levels).toHaveLength(5);
 for(const rgba of report.levels)expect(rgba).toEqual([42,56,62,255]);
 expect(report.errors).toEqual([]);
 await page.getByRole("button",{name:"Top",exact:true}).click();
 await page.getByText("Appearance",{exact:true}).click();
 await page.getByRole("button",{name:"Restore source appearance",exact:true}).click();
 await page.getByLabel("Inspect floor textures without lighting",{exact:true}).check();
 await page.getByText("Appearance",{exact:true}).click();
 for(let i=0;i<4;i++)await page.getByRole("button",{name:"Zoom out",exact:true}).click();
 for(const mode of ["auto","source","anisotropic"]) {
  await page.getByText("Appearance",{exact:true}).click();
  await page.getByLabel("Floor texture minification",{exact:true}).selectOption(mode);
  await page.getByText("Appearance",{exact:true}).click();
  const png=(await page.getByTestId("twin-canvas").screenshot()).toString("base64");
  const rgb=await page.evaluate(async png=>{
   const image=await createImageBitmap(new Blob([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],{type:"image/png"}));
   const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;
   const context=canvas.getContext("2d")!;context.drawImage(image,0,0);image.close();
   return [...context.getImageData(Math.floor(canvas.width/2)+12,Math.floor(canvas.height/2)+12,1,1).data].slice(0,3);
  },png);
  for(let channel=0;channel<3;channel++)expect(Math.abs(rgb[channel]!-[42,56,62][channel]!)).toBeLessThanOrEqual(3);
 }
});
