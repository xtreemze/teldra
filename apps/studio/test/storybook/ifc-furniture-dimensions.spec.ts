import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** Resolve Storybook's own generated IDs, which split digits in export names. */
async function openStory(page: Page, fragment: string): Promise<void> {
  const response = await page.request.get("/index.json");
  expect(response.ok()).toBe(true);
  const data = await response.json() as {
    entries: Record<string, {title: string; name: string}>;
  };
  const matching = Object.entries(data.entries).find(([id, entry]) =>
    entry.title === "Studio/IfcFurnitureDimensions" && id.includes(fragment));
  if (!matching) throw new Error("Missing Storybook furniture dimensions story: " + fragment);
  await page.goto("/iframe.html?id=" + matching[0] + "&viewMode=story");
}

test("editable SH3D nominal dimensions preview mapped scale and remain cancellable", async ({page}) => {
  await openStory(page, "editable");
  await page.getByRole("button",{name:"Edit placement",exact:true}).click();
  await expect(page.getByLabel("Nominal width (m)",{exact:true})).toHaveValue("0.5");
  await expect(page.getByLabel("Nominal depth (m)",{exact:true})).toHaveValue("0.5");
  await expect(page.getByLabel("Nominal height (m)",{exact:true})).toHaveValue("1");

  await page.getByLabel("Nominal width (m)",{exact:true}).fill("0.75");
  await page.getByLabel("Nominal width (m)",{exact:true}).press("Tab");
  await expect(page.getByTestId("preview-scale")).toHaveText("1.5,1,1");
  await expect(page.getByLabel("Scale X",{exact:true})).toHaveValue("1.5");
  await page.getByLabel("Nominal height (m)",{exact:true}).fill("1.25");
  await page.getByLabel("Nominal height (m)",{exact:true}).press("Tab");
  await expect(page.getByTestId("preview-scale")).toHaveText("1.5,1,1.25");
  await page.getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(page.getByTestId("committed-scale")).toHaveText("1,1,1");

  await page.getByRole("button",{name:"Edit placement",exact:true}).click();
  await page.getByLabel("Nominal width (m)",{exact:true}).fill("-1");
  await page.getByLabel("Nominal width (m)",{exact:true}).press("Tab");
  await expect(page.getByLabel("Nominal width (m)",{exact:true})).toHaveAttribute("aria-invalid","true");
  await expect(page.getByRole("alert")).toContainText("Nominal dimensions");
  await page.getByRole("button",{name:"Apply placement",exact:true}).click();
  await expect(page.getByTestId("committed-scale")).toHaveText("1,1,1");
  await expect(page.getByLabel("Nominal width (m)",{exact:true})).toBeVisible();
  await page.getByLabel("Nominal width (m)",{exact:true}).fill("0.5");
  await page.getByLabel("Nominal width (m)",{exact:true}).press("Tab");
  await expect(page.getByLabel("Nominal width (m)",{exact:true})).toHaveAttribute("aria-invalid","false");
  await page.getByLabel("Nominal depth (m)",{exact:true}).fill("0.75");
  await page.getByLabel("Nominal depth (m)",{exact:true}).press("Tab");
  await page.getByRole("button",{name:"Apply placement",exact:true}).click();
  await expect(page.getByTestId("committed-scale")).toHaveText("1,1.5,1");
  const accessibility = await new AxeBuilder({page}).include("#storybook-root")
    .disableRules(["landmark-one-main","page-has-heading-one"]).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("native IFC without SH3D source provenance retains scale factor editor only", async ({page}) => {
  await openStory(page, "missing");
  await page.getByRole("button",{name:"Edit placement",exact:true}).click();
  await expect(page.getByTestId("nominal-dimensions-unavailable")).toBeVisible();
  await expect(page.getByLabel("Scale X",{exact:true})).toHaveValue("1");
  await expect(page.getByLabel("Nominal width (m)",{exact:true})).toHaveCount(0);
});
