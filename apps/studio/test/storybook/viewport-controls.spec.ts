import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("navigation gizmo, camera controls and composed layers operate on the loaded scene", async ({page}) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/iframe.html?id=studio-sh3d-visual-transport--textured-furniture-and-hidden-content&viewMode=story");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  const state = async () => JSON.parse(await page.getByTestId("camera-state").textContent() ?? "{}");
  const initial = await state();
  await page.getByRole("button", {name: "View from +X", exact: true}).click();
  await expect.poll(async () => (await state()).alpha).toBe(0);
  await expect(page.getByRole("button", {name: "View from +X", exact: true})).toBeFocused();
  await page.getByRole("button", {name: "Top", exact: true}).click();
  await expect.poll(async () => (await state()).beta).toBeCloseTo(0.001);
  await page.getByLabel("Projection", {exact: true}).selectOption("orthographic");
  await expect.poll(async () => (await state()).projection).toBe("orthographic");
  const radius = (await state()).radius;
  await page.getByRole("button", {name: "Zoom in", exact: true}).click();
  await expect.poll(async () => (await state()).radius).toBeLessThan(radius);
  const target = (await state()).target;
  await page.getByRole("button", {name: "Pan right", exact: true}).click();
  await expect.poll(async () => (await state()).target).not.toEqual(target);
  const canvas = page.getByTestId("twin-canvas"); await canvas.focus(); await canvas.press("7");
  await expect.poll(async () => (await state()).beta).toBeCloseTo(0.001);
  await canvas.press("Home");
  await expect.poll(async () => (await state()).projection).toBe("orthographic");
  await canvas.press("Shift+Home");
  await expect.poll(async () => (await state()).projection).toBe("perspective");
  await expect(page.getByRole("button", {name: "Fit selection", exact: true})).toBeDisabled();
  await page.getByText("Layers", {exact: true}).click();
  const inspect = async () => { await page.getByRole("button", {name: "Inspect source assets"}).click(); };
  const summary = page.getByTestId("source-asset-summary");
  const furniture = page.getByLabel("Furniture", {exact: false});
  await furniture.focus(); await furniture.press("Space");
  await expect(furniture).toBeFocused();
  await expect(furniture).not.toBeChecked(); await inspect();
  await expect(summary).toContainText('"visibleMeshParts":0');
  await page.getByLabel("Show hidden source content").check(); await inspect();
  await expect(summary).toContainText('"visibleMeshParts":1');
  await page.getByLabel("Upper floor", {exact: false}).uncheck(); await inspect();
  await expect(summary).toContainText('"visibleMeshParts":0');
  await page.getByLabel("Furniture", {exact: false}).check(); await inspect();
  await expect(summary).toContainText('"visibleMeshParts":1');
  expect(initial.radius).toBeGreaterThan(0); expect(errors).toEqual([]);
});

test("orbit drags do not become selection clicks", async ({page}) => {
  await page.goto("/iframe.html?id=studio-twinviewport--identity-picking");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  const canvas = page.getByTestId("twin-canvas"); const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, {steps: 8}); await page.mouse.up();
  await expect(page.getByTestId("selected-canonical-id")).toHaveText("unattempted");
});


test("viewport controls remain keyboard accessible on compact screens", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/iframe.html?id=studio-sh3d-visual-transport--textured-furniture-and-hidden-content&viewMode=story");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await page.getByText("Layers", {exact: true}).click();
  await page.getByTestId("twin-canvas").focus();
  await page.getByTestId("twin-canvas").press("5");
  await expect(page.getByLabel("Projection", {exact: true})).toHaveValue("orthographic");
  const results = await new AxeBuilder({page}).include("#storybook-root").analyze();
  expect(results.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});


test("Blender middle drag orbits and Shift+middle drag pans without selecting content", async ({page}) => {
  await page.goto("/iframe.html?id=studio-sh3d-visual-transport--textured-furniture-and-hidden-content&viewMode=story");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  const state = async () => JSON.parse(await page.getByTestId("camera-state").textContent() ?? "{}");
  const box = await page.getByTestId("twin-canvas").boundingBox();
  if (!box) throw new Error("Canvas missing");
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const initial = await state();
  await page.mouse.move(x, y);
  await page.mouse.down({button: "middle"});
  await page.mouse.move(x + 70, y + 25, {steps: 12});
  await page.mouse.up({button: "middle"});
  await expect.poll(async () => (await state()).alpha).not.toBeCloseTo(initial.alpha, 2);
  const afterOrbit = await state();
  await page.keyboard.down("Shift");
  await page.mouse.move(x, y);
  await page.mouse.down({button: "middle"});
  await page.mouse.move(x + 70, y + 25, {steps: 12});
  await page.mouse.up({button: "middle"});
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await state()).target).not.toEqual(afterOrbit.target);
});
