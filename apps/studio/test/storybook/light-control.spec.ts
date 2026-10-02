import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("Solid light control is interactive and accessible", async ({ page }) => {
  await page.goto("/iframe.html?id=studio-lightcontrol--interactive&viewMode=story");

  const control = page.getByRole("button", { name: /floor lamp/i });
  await expect(control).toHaveAttribute("aria-pressed", "true");

  await control.click();
  await expect(control).toHaveAttribute("aria-pressed", "false");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});
