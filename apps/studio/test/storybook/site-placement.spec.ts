import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = "/iframe.html?id=studio-siteplacementpanel--suggest-from-candidate&viewMode=story";

test("suggests a placement from a picked candidate, confirms it through the command and undoes it", async ({ page }) => {
  await page.goto(story);
  await expect(page.getByText("Not placed")).toBeVisible();

  await page.getByRole("button", { name: "Find buildings" }).click();
  await expect(page.getByRole("list").getByRole("button")).toHaveCount(15);
  await expect(page.getByText(/OpenStreetMap contributors, ODbL/)).toBeVisible();

  await page.getByRole("list").getByRole("button", { name: /osm:way\/1000003/ }).click();
  const suggestion = page.getByText(/Residual RMS/);
  await expect(suggestion).toBeVisible();
  await expect(page.getByText("Provisional")).toBeVisible();
  await expect(page.getByLabel("IFC footprint under current placement")).toBeVisible();

  await page.getByRole("button", { name: "Rotate +1°" }).click();
  await page.getByRole("button", { name: "Confirm and save" }).click();
  await expect(page.getByText("Confirmed by you")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Not placed")).toBeVisible();

  const results = await new AxeBuilder({ page }).include("#storybook-root").disableRules(["landmark-one-main", "page-has-heading-one"]).analyze();
  expect(results.violations).toEqual([]);
});

test("reports the residual for a poorly matching candidate instead of hiding it", async ({ page }) => {
  await page.goto(story);
  await page.getByRole("button", { name: "Find buildings" }).click();
  await page.getByRole("list").getByRole("button", { name: /osm:way\/1000001/ }).click();
  await expect(page.getByText(/Residual RMS/)).toBeVisible();
});
