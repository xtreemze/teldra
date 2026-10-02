import { expect, test } from "@playwright/test";

test("loads the GLB and resolves a picked render node to canonical identity", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=studio-twinviewport--identity-picking");

  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await expect(page.getByTestId("viewport-backend")).toHaveText(/webgpu|webgl/);

  const canvas = page.getByTestId("twin-canvas");
  await expect(canvas).toBeVisible();

  await canvas.click();

  await expect(page.getByTestId("selected-canonical-id")).toHaveText(
    "wall:fixture",
  );
});
