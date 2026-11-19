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
  // Eligibility becomes authoritative only after opening the IFC editor.
  // The entry action itself must remain accessible before that preparation.
  await actions.getByRole("button", {name: "Move", exact: true}).click();
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

for (const width of [320, 390]) {
  test(`mobile toolbar and View panel stay inside the viewport at ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height: 844});
    await page.goto("./?demo=sample");
    await page.getByRole("button", {name: "Try demo", exact: true}).click();
    await expect(page.getByTestId("viewport-status")).toHaveText("ready");

    const scene = page.getByRole("button", {name: "Scene", exact: true});
    const view = page.getByRole("button", {name: "View", exact: true});
    const project = page.getByRole("button", {name: "Project", exact: true});
    const settings = page.getByRole("group", {name: "Mobile view settings"});
    const projectMenu = page.getByRole("group", {name: "Mobile project menu"});
    const canvas = (await page.getByTestId("twin-canvas").boundingBox())!;
    const boxes = await Promise.all([scene, view, project].map(button => button.boundingBox()));
    for (const box of boxes) {
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(canvas.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
      expect(Math.abs(box!.y - boxes[0]!.y)).toBeLessThanOrEqual(1);
    }
    expect(boxes[0]!.x + boxes[0]!.width).toBeLessThan(boxes[1]!.x);
    expect(boxes[1]!.x + boxes[1]!.width).toBeLessThan(boxes[2]!.x);

    await view.click();
    await expect(settings).toBeVisible();
    const panel = (await settings.boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(canvas.x);
    expect(panel.x + panel.width).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
    expect(panel.y + panel.height).toBeLessThanOrEqual(canvas.y + canvas.height + 1);

    await project.click();
    await expect(settings).toBeHidden();
    await expect(projectMenu).toBeVisible();
    await scene.click();
    await expect(projectMenu).toBeHidden();
    await expect(page.getByLabel("Search scene")).toBeVisible();
    await view.click();
    await expect(page.getByLabel("Search scene")).toBeHidden();
    await expect(settings).toBeVisible();
    await settings.getByRole("button", {name: "Top", exact: true}).focus();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(view).toBeFocused();
    await expect(view).toHaveAttribute("aria-expanded", "false");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
