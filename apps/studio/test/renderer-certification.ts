import { expect, test, type Page } from "@playwright/test";

/** Require a real WebGPU renderer, while keeping the ordinary suite portable. */
export async function requireWebGpuBackend(page: Page): Promise<void> {
  const backend = await page.locator(".teldra-twin-viewport").getAttribute("data-backend");
  if (backend === "webgpu") return;

  const message = `WebGPU certification requires the WebGPU backend; observed ${backend ?? "no backend"}`;
  if (process.env.TELDRA_REQUIRE_WEBGPU === "1") {
    expect(backend, message).toBe("webgpu");
    return;
  }

  test.skip(true, message);
}
