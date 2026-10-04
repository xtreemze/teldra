import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("Studio shell opens the Golden Home editing workflow", async ({
  page,
}) => {
  await page.goto(
    "/iframe.html?id=studio-application--golden-home&viewMode=story",
  );

  await page.getByRole("button", { name: "Open .teldra" }).click();
  await expect(
    page.getByTestId("project-name"),
  ).toHaveText("golden-home.teldra");

  const input = page.getByLabel("Device name");
  await input.fill("Reading lamp");
  await page.getByRole("button", { name: "Apply name" }).click();

  await expect(
    page.getByTestId("canonical-device-name"),
  ).toHaveText("Reading lamp");
  await expect(
    page.getByTestId("project-dirty-state"),
  ).toHaveText("Unsaved changes");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.getByTestId("canonical-device-name"),
  ).toHaveText("Living room floor lamp");

  await page.getByRole("button", { name: "Redo" }).click();
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(
    page.getByTestId("project-dirty-state"),
  ).toHaveText("Saved");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("Studio shell gives an explicit read-only fallback message", async ({
  page,
}) => {
  await page.goto(
    "/iframe.html?id=studio-application--unsupported-browser&viewMode=story",
  );

  await expect(
    page.getByRole("heading", {
      name: "Local project access unavailable",
    }),
  ).toBeVisible();
});
