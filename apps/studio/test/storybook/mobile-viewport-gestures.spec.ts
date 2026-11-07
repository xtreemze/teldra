import {expect, test} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const story = "/iframe.html?id=studio-twinviewport--touch-gesture-arbitration&viewMode=story";

test.beforeEach(async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto(story);
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
});

test("three-touch horizontal swipe emits one undo/redo intent without selecting meshes", async ({page}) => {
  const canvas = page.getByTestId("twin-canvas");
  await canvas.evaluate(element => {
    const pointer = (type: string, id: number, x: number, y: number) =>
      element.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true,
        pointerId: id, pointerType: "touch", clientX: x, clientY: y}));
    for (const [id, x] of [[1, 120], [2, 190], [3, 260]]) pointer("pointerdown", id, x, 350);
    for (const [id, x] of [[1, 10], [2, 80], [3, 150]]) pointer("pointermove", id, x, 350);
    for (const [id, x] of [[1, 10], [2, 80], [3, 150]]) pointer("pointerup", id, x, 350);
    element.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, clientX: 10, clientY: 350}));
  });
  await expect(page.getByTestId("touch-intent")).toHaveText("undo");
  await expect(page.getByTestId("touch-selected-id")).toHaveText("none");

  await canvas.evaluate(element => {
    const pointer = (type: string, id: number, x: number, y: number) =>
      element.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true,
        pointerId: id, pointerType: "touch", clientX: x, clientY: y}));
    for (const [id, x] of [[11, 30], [12, 100], [13, 170]]) pointer("pointerdown", id, x, 350);
    for (const [id, x] of [[11, 140], [12, 210], [13, 280]]) pointer("pointermove", id, x, 350);
    for (const [id, x] of [[11, 140], [12, 210], [13, 280]]) pointer("pointerup", id, x, 350);
  });
  await expect(page.getByTestId("touch-intent")).toHaveText("redo");
});

test("double-tap frames only the selected picked object", async ({page}) => {
  const x = Number(await page.getByTestId("touch-projected-x").textContent());
  const y = Number(await page.getByTestId("touch-projected-y").textContent());
  expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  await page.mouse.click(x, y);
  await expect(page.getByTestId("touch-selected-id")).toHaveText("wall:fixture");
  await page.getByTestId("twin-canvas").evaluate((element, at) => {
    const pointer = (type: string, id: number) =>
      element.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true,
        pointerId: id, pointerType: "touch", clientX: at.x, clientY: at.y}));
    for (const id of [11, 12]) { pointer("pointerdown", id); pointer("pointerup", id); }
    element.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, clientX: at.x, clientY: at.y}));
  }, {x, y});
  await expect(page.getByTestId("touch-intent")).toHaveText("frame:wall:fixture");
  await expect(page.getByTestId("touch-selected-id")).toHaveText("wall:fixture");
});

test("long press emits object menu intent and suppresses the release click", async ({page}) => {
  const x = Number(await page.getByTestId("touch-projected-x").textContent());
  const y = Number(await page.getByTestId("touch-projected-y").textContent());
  const canvas = page.getByTestId("twin-canvas");
  await canvas.evaluate((element, at) => {
    element.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true, cancelable: true,
      pointerId: 4, pointerType: "touch", clientX: at.x, clientY: at.y}));
  }, {x,y});
  await expect(page.getByTestId("touch-intent")).toHaveText("menu:wall:fixture", {timeout: 2500});
  await canvas.evaluate((element, at) => {
    element.dispatchEvent(new PointerEvent("pointerup", {bubbles: true, cancelable: true,
      pointerId: 4, pointerType: "touch", clientX: at.x, clientY: at.y}));
    element.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true,
      clientX: at.x, clientY: at.y}));
  }, {x,y});
  await expect(page.getByTestId("touch-selected-id")).toHaveText("none");
});

test("two-touch camera navigation and disabled gestures never produce a history intent", async ({page}) => {
  const canvas = page.getByTestId("twin-canvas");
  await canvas.evaluate(element => {
    const pointer = (type: string, id: number, x: number, y: number) =>
      element.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true,
        pointerId: id, pointerType: "touch", clientX: x, clientY: y}));
    pointer("pointerdown", 1, 40, 200); pointer("pointerdown", 2, 140, 200);
    pointer("pointermove", 1, 30, 180); pointer("pointermove", 2, 165, 210);
    pointer("pointerup", 1, 30, 180); pointer("pointerup", 2, 165, 210);
  });
  await expect(page.getByTestId("touch-intent")).toHaveText("none");

  await page.getByRole("button", {name: "Disable canvas gestures"}).click();
  await canvas.evaluate(element => {
    const pointer = (type: string, id: number, x: number, y: number) =>
      element.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true,
        pointerId: id, pointerType: "touch", clientX: x, clientY: y}));
    for (const [id, x] of [[11, 120], [12, 190], [13, 260]]) pointer("pointerdown", id, x, 350);
    for (const [id, x] of [[11, 10], [12, 80], [13, 150]]) pointer("pointermove", id, x, 350);
    for (const [id, x] of [[11, 10], [12, 80], [13, 150]]) pointer("pointerup", id, x, 350);
  });
  await expect(page.getByTestId("touch-intent")).toHaveText("none");
  const report = await new AxeBuilder({page}).include("#storybook-root").analyze();
  expect(report.violations).toEqual([]);
});
