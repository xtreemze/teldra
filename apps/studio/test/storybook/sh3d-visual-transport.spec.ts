import { expect, test } from "@playwright/test";

test("loads source textures and Phong appearance and reveals hidden source content", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/iframe.html?id=studio-sh3d-visual-transport--textured-furniture-and-hidden-content&viewMode=story");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  const summary = page.getByTestId("source-asset-summary");
  await expect(summary).toContainText('"sourcePhongMaterials":1');
  await expect(summary).toContainText('"texturesReady":true');
  await expect(summary).toContainText('"lightingProfile":"sh3d-preview-v1"');
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

test("reverse-Z renderer flag is honored without losing source textures", async ({page}) => {
  const errors:string[]=[];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/iframe.html?id=studio-sh3d-visual-transport--textured-furniture-and-hidden-content&viewMode=story&depth=reverse");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await expect(page.locator(".teldra-twin-viewport")).toHaveAttribute("data-depth-mode", "reverse");
  await expect(page.getByTestId("source-asset-summary")).toContainText('"texturesReady":true');
  expect(errors).toEqual([]);
});

test("surface identification can be armed without editing the SH3D scene", async ({page}) => {
  await page.goto("/iframe.html?id=studio-sh3d-visual-transport--textured-furniture-and-hidden-content&viewMode=story");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await page.getByText("Appearance",{exact:true}).click();
  await page.getByRole("button",{name:"Identify visible surface",exact:true}).click();
  await expect(page.getByText("Tap the dark floor once to identify the visible surface.")).toBeVisible();
  await expect(page.getByRole("button",{name:"Identify visible surface",exact:true})).toHaveText("Tap a floor to identify it");
  const status=page.getByTestId("source-asset-summary");
  await expect(status).toContainText('"sourcePhongMaterials":1');
});
