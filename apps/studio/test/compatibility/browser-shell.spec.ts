import {expect, test} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("cross-engine Pages shell keeps project and PWA entry accessible", async ({page}) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("./?demo=sample");
  await expect(page.getByRole("heading", {name: "Open a project"})).toBeVisible();
  await expect(page.getByRole("button", {name: "Try demo"})).toBeVisible();

  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestUrl).toBe("./manifest.webmanifest");
  const response = await page.request.get(new URL(manifestUrl!, page.url()).href);
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({display: "standalone", scope: "./"});
  const report = await new AxeBuilder({page}).include("main").analyze();
  expect(report.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("cross-engine sample project loads 3D and mobile controls when a graphics context is available", async ({page}) => {
  await page.goto("./?demo=sample");
  const webgl2Available = await page.evaluate(() => {
    try {
      const canvas = document.createElement("canvas");
      return canvas.getContext("webgl2") !== null;
    } catch {
      return false;
    }
  });
  test.skip(!webgl2Available, "CI runner cannot create WebGL2: this browser/backend remains untested on physical hardware");

  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", {name: "Try demo"}).click();
  await expect(page.getByTestId("viewport-status")).toHaveText("ready", {timeout: 90_000});

  const scene = page.getByRole("button", {name: "Scene", exact: true});
  const view = page.getByRole("button", {name: "View", exact: true});
  await expect(scene).toBeVisible();
  await expect(view).toBeVisible();
  await scene.click();
  await expect(page.getByLabel("Search scene", {exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Close Scene sheet"}).click();
  await view.click();
  await expect(page.getByRole("group", {name: "Mobile view settings"})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
