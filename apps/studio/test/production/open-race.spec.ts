import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { goldenHomeArchive } from "./golden-home-archive";

// Regression: the auto-opened 21D demo is still downloading when the user opens their own project. The user's
// choice is the latest request, so the slow demo completing afterwards must not replace it.
test("a slow demo load never overwrites a project the user opened after it", async ({ page }, testInfo) => {
  const archive = testInfo.outputPath("golden-home.teldra");
  writeFileSync(archive, await goldenHomeArchive());
  let releaseDemo!: () => void;
  const demoHeld = new Promise<void>((resolve) => { releaseDemo = resolve; });
  let demoRequested = false;
  await page.route("**/21D.teldra", async (route) => {
    demoRequested = true;
    await demoHeld;
    await route.continue();
  });
  await page.addInitScript(() => Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true }));
  await page.goto("./");
  await expect.poll(() => demoRequested).toBe(true);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open .teldra", exact: true }).click();
  await (await chooser).setFiles(archive);
  await expect(page.getByTestId("browser-project-file")).toHaveText(/^golden-home.*\.teldra$/);
  releaseDemo();
  // The demo finishes after the user's open; give it ample opportunity to (wrongly) replace the project.
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.endsWith("21D.teldra") && e.responseEnd > 0)), { timeout: 60_000 }).toBe(true);
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("browser-project-file")).toHaveText(/^golden-home.*\.teldra$/);
  await expect(page.getByRole("status").filter({ hasText: "Opening 3D workspace" })).toHaveCount(0);
});
