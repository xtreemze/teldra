import {expect, test} from "@playwright/test";
import {requireWebGpuBackend} from "../renderer-certification";

test("WebGPU mip uploads survive loading, resizing and renderer recreation", async ({page}) => {
  await page.addInitScript(() => {
    if (typeof GPUDevice === "undefined") return;
    const state = {textures: [] as {texture: GPUTexture; device: GPUDevice}[], errors: new Map<GPUDevice, string[]>()};
    Object.assign(window, {teldraLifecycleTest: state});
    const create = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (descriptor) {
      if (!state.errors.has(this)) {
        const errors: string[] = [];
        state.errors.set(this, errors);
        this.addEventListener("uncapturederror", event => errors.push(event.error.message));
      }
      const texture = create.call(this, descriptor);
      if (descriptor.label?.includes("dark.png")) state.textures.push({texture, device: this});
      return texture;
    };
  });

  const url = "/iframe.html?id=studio-sh3d-visual-transport--dark-floor-color-transfer&viewMode=story";
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.setViewportSize({width: 1024, height: 768});
    // Resize immediately after navigation commits, before the fixture's modules and scene finish loading.
    await page.goto(url, {waitUntil: "commit"});
    await page.setViewportSize({width: 1180, height: 820});
    await expect(page.getByTestId("viewport-status")).toHaveText("ready");
    await requireWebGpuBackend(page);

    // Exercise a second resize after the renderer is live, then wait for rendered frames.
    await page.setViewportSize({width: 1100, height: 760});
    const report = await page.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const state = (window as unknown as {teldraLifecycleTest: {
        textures: {texture: GPUTexture; device: GPUDevice}[]; errors: Map<GPUDevice, string[]>;
      }}).teldraLifecycleTest;
      const latest = state.textures.at(-1);
      if (!latest) return {count: 0, levels: [], errors: ["Fixture GPU texture was not created"]};
      const {texture, device} = latest;
      await device.queue.onSubmittedWorkDone();
      const levels = [];
      for (const level of [0, Math.floor((texture.mipLevelCount - 1) / 2), texture.mipLevelCount - 1]) {
        const buffer = device.createBuffer({size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({texture, mipLevel: level}, {buffer, bytesPerRow: 256}, {width: 1, height: 1});
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        levels.push({level, rgba: [...new Uint8Array(buffer.getMappedRange()).slice(0, 4)]});
        buffer.unmap();
        buffer.destroy();
      }
      await device.queue.onSubmittedWorkDone();
      return {count: texture.mipLevelCount, levels, errors: state.errors.get(device) ?? []};
    });
    await test.info().attach(`lifecycle-cycle-${cycle}`, {body: JSON.stringify(report), contentType: "application/json"});
    expect(report.count).toBe(5);
    expect(report.levels).toEqual([0, 2, 4].map(level => ({level, rgba: [42, 56, 62, 255]})));
    expect(report.errors).toEqual([]);
  }
});
