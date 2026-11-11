import { expect, test } from "@playwright/test";

test("Studio toolbar uses a single accessible 24px icon system", async ({ page }) => {
  await page.goto("./?demo=sample");
  await page.getByRole("button", { name: "Try demo" }).click();
  await expect(page.getByTestId("viewport-status")).toHaveText("ready", { timeout: 90000 });

  for (const name of ["Scene", "Inspector", "Undo", "Redo", "Fit scene", "Fit selection"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toHaveCount(1);
    const icon = button.locator("svg.teldra-studio-icon");
    await expect(icon).toHaveCount(1);
    await expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
    await expect(icon).toHaveAttribute("stroke-width", "1.8");
    await expect(icon).toHaveAttribute("aria-hidden", "true");
  }
  const icons = page.locator("svg.teldra-studio-icon");
  expect(await icons.count()).toBeGreaterThan(10);
});

test("the compact icon toolbar keeps existing text labels and does not overflow", async ({ page }) => {
  await page.setViewportSize({width: 320, height: 640});
  await page.goto("./?demo=sample");
  await page.getByRole("button", { name: "Try demo" }).click();
  await expect(page.getByTestId("viewport-status")).toHaveText("ready", { timeout: 90000 });
  const scene = page.getByRole("button", { name: "Scene", exact: true });
  const project = page.getByRole("button", { name: "Project", exact: true });
  await expect(scene.locator("svg.teldra-studio-icon")).toHaveCount(1);
  await expect(project.locator("svg.teldra-studio-icon")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
