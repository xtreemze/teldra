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
  await expect(actions.getByRole("button", {name: "Scale", exact: true})).toBeEnabled();
  // The menu can start Scale before IFC is loaded; eligibility is checked asynchronously.
  await actions.getByRole("button", {name: "Scale", exact: true}).click();
  const touchModes = page.getByRole("group", {name: "Touch editing mode"});
  await expect(touchModes).toBeVisible();
  const scalePressed = await touchModes.getByRole("button", {name: "Scale", exact: true}).getAttribute("aria-pressed");
  if (scalePressed !== "true") {
    await expect(page.getByTestId("transform-shortcut-status")).toContainText("Scale unavailable");
    await expect(touchModes.getByRole("button", {name: "Move", exact: true})).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("group", {name: "Touch transform actions"}).getByRole("button", {name: "Cancel", exact: true}).click();
  await page.getByRole("group", {name: "Mobile selection actions"}).getByRole("button", {name: "Move", exact: true}).click();
  await expect(page.getByRole("button", {name: "Numbers", exact: true})).toBeVisible();
  await expect(page.getByRole("group", {name: "Touch editing mode"})).toBeVisible();
  await page.getByRole("button", {name: "Numbers", exact: true}).click();
  await expect(page.getByLabel("Position X (m)", {exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Gestures", exact: true}).click();
  await expect(page.getByRole("group", {name: "Touch editing mode"})).toBeVisible();
  await page.getByRole("group", {name: "Touch transform actions"})
    .getByRole("button", {name: "Cancel", exact: true}).click();

  await page.getByRole("button", {name: "Project", exact: true}).click();
  await expect(page.getByRole("group", {name: "Mobile project menu"})).toBeVisible();
  await expect(page.getByRole("button", {name: "Save project", exact: true})).toBeDisabled();
  await page.getByRole("button", {name: "Haptics on", exact: true}).click();
  await expect(page.getByRole("button", {name: "Haptics off", exact: true})).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", {name: "Sounds off", exact: true}).click();
  await expect(page.getByRole("button", {name: "Sounds on", exact: true})).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await page.getByRole("button", {name: "Try demo", exact: true}).click();
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await page.getByRole("button", {name: "Project", exact: true}).click();
  await expect(page.getByRole("button", {name: "Haptics off", exact: true})).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", {name: "Sounds on", exact: true})).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
