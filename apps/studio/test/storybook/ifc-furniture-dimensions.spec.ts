import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = "/iframe.html?id=studio-ifcfurnituredimensions--editable-sh3d-nominal-size&viewMode=story";

test("editable SH3D nominal dimensions preview mapped scale and remain cancellable", async ({page}) => {
  await page.goto(story);
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
  await page.getByLabel("Nominal depth (m)",{exact:true}).fill("0.75");
  await page.getByLabel("Nominal depth (m)",{exact:true}).press("Tab");
  await page.getByRole("button",{name:"Apply placement",exact:true}).click();
  await expect(page.getByTestId("committed-scale")).toHaveText("1,1.5,1");
  const accessibility = await new AxeBuilder({page}).include("#storybook-root")
    .disableRules(["landmark-one-main","page-has-heading-one"]).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("native IFC without SH3D source provenance retains scale factor editor only", async ({page}) => {
  await page.goto("/iframe.html?id=studio-ifcfurnituredimensions--missing-source-provenance&viewMode=story");
  await page.getByRole("button",{name:"Edit placement",exact:true}).click();
  await expect(page.getByTestId("nominal-dimensions-unavailable")).toBeVisible();
  await expect(page.getByLabel("Scale X",{exact:true})).toHaveValue("1");
  await expect(page.getByLabel("Nominal width (m)",{exact:true})).toHaveCount(0);
});
