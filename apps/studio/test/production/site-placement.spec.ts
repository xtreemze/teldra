import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFileSync } from "node:fs";
import { goldenHomeArchive, overpassFixtureBody } from "./golden-home-archive";

// Everything here is synthetic: the golden-home fixture, and an Overpass-shaped response for a made-up block
// near 0.5 N 0.5 E. The public Overpass endpoint is mocked; nothing real is ever requested.
const OVERPASS = "https://overpass-api.de/**";

async function openArchive(page: Page, path: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open .teldra", exact: true }).click();
  await (await chooser).setFiles(path);
  await expect(page.getByTestId("browser-project-file")).toHaveText(/^golden-home.*\.teldra$/);
}

async function setup(page: Page, testInfo: { outputPath(name: string): string }) {
  const archive = testInfo.outputPath("golden-home.teldra");
  writeFileSync(archive, await goldenHomeArchive());
  const overpassRequests: string[] = [];
  await page.route(OVERPASS, async (route) => {
    overpassRequests.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: overpassFixtureBody() });
  });
  await page.addInitScript(() => Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true }));
  return { archive, overpassRequests };
}

const site = (page: Page) => page.getByRole("dialog", { name: "Site placement" });
const lat = (page: Page) => site(page).getByLabel("Latitude (°)", { exact: true });
const lon = (page: Page) => site(page).getByLabel("Longitude (°)", { exact: true });
const bearing = (page: Page) => site(page).getByLabel(/^Project-north bearing/);
const elevation = (page: Page) => site(page).getByLabel("Elevation (m)", { exact: true });

async function enter(field: ReturnType<typeof lat>, value: string) {
  await field.fill(value);
  await field.press("Tab");
}

test("Site panel: enter and adjust a placement, confirm, undo/redo, save, reopen", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { archive, overpassRequests } = await setup(page, testInfo);
  await page.goto("./");
  await openArchive(page, archive);

  await page.getByRole("button", { name: "Site", exact: true }).click();
  await expect(site(page)).toBeVisible();
  await expect(site(page).getByText("Not placed")).toBeVisible();
  expect(overpassRequests, "opening the panel must not contact any service").toHaveLength(0);

  // Manual entry, no network. Latitude, longitude, elevation and bearing are independent.
  await enter(lat(page), "0.5004");
  await enter(lon(page), "0.5022");
  await enter(elevation(page), "12");
  await enter(bearing(page), "30");
  await expect(site(page).getByLabel("IFC footprint under current placement")).toBeVisible();
  await site(page).getByRole("button", { name: "Confirm and save" }).click();
  await expect(site(page).getByText("Confirmed by you", { exact: true })).toBeVisible();
  expect(overpassRequests).toHaveLength(0);
  await expect(site(page).getByRole("button", { name: "Save project" })).toBeEnabled();

  // Adjust one field only; the other three stay as entered.
  await enter(bearing(page), "45");
  await expect(site(page).getByText("Confirmed by you (unsaved edits)")).toBeVisible();
  await expect(lat(page)).toHaveValue("0.5004");
  await expect(lon(page)).toHaveValue("0.5022");
  await expect(elevation(page)).toHaveValue("12");
  await site(page).getByRole("button", { name: "Confirm and save" }).click();
  await expect(site(page).getByText("Confirmed by you", { exact: true })).toBeVisible();

  // Explicit, opt-in candidate search against the mocked service.
  await site(page).getByLabel("South", { exact: true }).fill("0.4999");
  await site(page).getByLabel("West", { exact: true }).fill("0.4999");
  await site(page).getByLabel("North", { exact: true }).fill("0.5008");
  await site(page).getByLabel("East", { exact: true }).fill("0.5031");
  await site(page).getByRole("button", { name: "Find buildings" }).click();
  await expect(site(page).getByRole("list").getByRole("button")).toHaveCount(15);
  expect(overpassRequests).toHaveLength(1);
  await site(page).getByRole("list").getByRole("button", { name: /osm:way\/1000003/ }).click();
  await expect(site(page).getByText(/Residual RMS/)).toBeVisible();
  await site(page).getByRole("button", { name: "Confirm and save" }).click();
  await expect(site(page).getByText("Confirmed by you", { exact: true })).toBeVisible();
  const suggestedLat = await lat(page).inputValue();
  const suggestedLon = await lon(page).inputValue();
  const suggestedBearing = await bearing(page).inputValue();
  expect(suggestedLat).not.toBe("0.5004");

  // Shared twin history: undo returns to the previous confirmed placement, redo restores the candidate one.
  await site(page).getByRole("button", { name: "Undo", exact: true }).click();
  await expect(bearing(page)).toHaveValue("45");
  await expect(lat(page)).toHaveValue("0.5004");
  await site(page).getByRole("button", { name: "Redo", exact: true }).click();
  await expect(lat(page)).toHaveValue(suggestedLat);
  await expect(bearing(page)).toHaveValue(suggestedBearing);

  const results = await new AxeBuilder({ page }).include("dialog[open]").analyze();
  expect(results.violations).toEqual([]);

  const pending = page.waitForEvent("download");
  await site(page).getByRole("button", { name: "Save project" }).click();
  const saved = testInfo.outputPath("golden-home-sited.teldra");
  await (await pending).saveAs(saved);

  await page.reload();
  await openArchive(page, saved);
  await page.getByRole("button", { name: "Site", exact: true }).click();
  await expect(site(page).getByText("Confirmed by you", { exact: true })).toBeVisible();
  await expect(lat(page)).toHaveValue(suggestedLat);
  await expect(lon(page)).toHaveValue(suggestedLon);
  await expect(bearing(page)).toHaveValue(suggestedBearing);
  await expect(site(page).getByLabel("IFC footprint under current placement")).toBeVisible();
  expect(errors).toEqual([]);
});

test("Site panel is usable in the compact layout", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { archive, overpassRequests } = await setup(page, testInfo);
  await page.goto("./");
  await openArchive(page, archive);
  await page.getByRole("button", { name: "Site", exact: true }).click();
  await expect(site(page)).toBeVisible();
  await enter(lat(page), "0.5004");
  await enter(lon(page), "0.5022");
  await site(page).getByRole("button", { name: "Confirm and save" }).click();
  await expect(site(page).getByText("Confirmed by you", { exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await site(page).getByRole("button", { name: "Close" }).click();
  await expect(site(page)).toBeHidden();
  expect(overpassRequests).toHaveLength(0);
});
