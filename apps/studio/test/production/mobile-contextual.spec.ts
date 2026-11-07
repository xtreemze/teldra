import { expect, test } from "@playwright/test";

test("mobile Studio keeps the viewport primary and exposes contextual IFC editing", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("./?demo=sample");
  await page.getByRole("button", {name: "Try demo", exact: true}).click();
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");

  await expect(page.getByRole("button", {name: "Scene", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "View", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "Project", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "Fit scene", exact: true})).toBeHidden();
  await page.getByRole("button", {name: "View", exact: true}).click();
  await expect(page.getByRole("group", {name: "Mobile view settings"})).toBeVisible();
  await page.getByRole("button", {name: "View", exact: true}).click();

  await page.getByRole("button", {name: "Scene", exact: true}).click();
  const chair = page.getByRole("list", {name: "Building objects", exact: true}).getByRole("button", {name: /^Chair/});
  await expect(chair).toBeVisible();
  await chair.click();
  await expect(page.getByRole("group", {name: "Mobile selection actions"})).toBeVisible();
  await expect(chair).toBeHidden();

  await page.getByRole("button", {name: "More object actions", exact: true}).click();
  const actions = page.getByRole("group", {name: "Selected object actions"});
  await expect(actions).toBeVisible();
  await expect(actions.getByRole("button", {name: "Scale", exact: true})).toBeDisabled();
  await actions.getByRole("button", {name: "Move", exact: true}).click();
  await expect(page.getByLabel("Position X (m)", {exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Cancel", exact: true}).click();

  await page.getByRole("button", {name: "Project", exact: true}).click();
  await expect(page.getByRole("group", {name: "Mobile project menu"})).toBeVisible();
  await expect(page.getByRole("button", {name: "Save project", exact: true})).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
