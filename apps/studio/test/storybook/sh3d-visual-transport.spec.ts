import { expect, test } from "@playwright/test";

test("loads source textures and Phong appearance and reveals hidden source content", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/iframe.html?id=studio-sh3d-visual-transport--textured-furniture-and-hidden-content&viewMode=story");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  const summary = page.getByTestId("source-asset-summary");
  await expect(summary).toContainText('"sourcePhongMaterials":1');
  await expect(summary).toContainText('"texturesReady":true');
  await expect(summary).toContainText('"visibleMeshParts":1');
  const reveal = page.getByLabel("Show hidden source content");
  await expect(reveal).not.toBeChecked();
  await reveal.check();
  await page.getByRole("button", {name: "Inspect source assets"}).click();
  await expect(summary).toContainText('"visibleMeshParts":2');
  await reveal.uncheck();
  await page.getByRole("button", {name: "Inspect source assets"}).click();
  await expect(summary).toContainText('"visibleMeshParts":1');
  expect(errors).toEqual([]);
});
