import {expect, test} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("two-finger transform pad previews without auto-committing", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/iframe.html?id=studio-mobiletransformpad--move&viewMode=story");
  const target = page.getByRole("group", {name: "Two-finger transform touch area"});
  await expect(target).toBeVisible();
  await page.getByRole("button", {name: "Z", exact: true}).click();
  const before = await page.getByTestId("mobile-transform-pose").textContent();
  await target.evaluate(element => {
    const send = (name: string, id: number, x: number, y: number) =>
      element.dispatchEvent(new PointerEvent(name, {bubbles: true, pointerId: id, pointerType: "touch", clientX: x, clientY: y}));
    send("pointerdown", 1, 50, 180);
    send("pointerdown", 2, 150, 180);
    send("pointermove", 1, 50, 100);
    send("pointermove", 2, 150, 100);
    send("pointerup", 1, 50, 100);
    send("pointerup", 2, 150, 100);
  });
  expect(await page.getByTestId("mobile-transform-pose").textContent()).not.toBe(before);
  await expect(page.getByTestId("mobile-transform-delta")).toContainText("World Z:");
  await expect(page.locator(".teldra-mobile-transform-pad__announcement")).toContainText("Apply placement");
  const report = await new AxeBuilder({page}).include("#storybook-root").analyze();
  expect(report.violations).toEqual([]);
});

test("rotation uses two-touch twist without changing the object's dimensions", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/iframe.html?id=studio-mobiletransformpad--rotate&viewMode=story");
  await page.getByRole("group", {name: "Two-finger transform touch area"}).evaluate(element => {
    const send = (name: string, id: number, x: number, y: number) =>
      element.dispatchEvent(new PointerEvent(name, {bubbles: true, pointerId: id, pointerType: "touch", clientX: x, clientY: y}));
    send("pointerdown", 1, 50, 180); send("pointerdown", 2, 150, 180);
    send("pointermove", 1, 100, 130); send("pointermove", 2, 100, 230);
    send("pointerup", 1, 100, 130); send("pointerup", 2, 100, 230);
  });
  const text = await page.getByTestId("mobile-transform-pose").textContent();
  const pose = JSON.parse(text ?? "{}");
  expect(pose.position).toEqual([1, 2, 3]);
  expect(pose.yawRadians).toBeCloseTo(Math.PI / 2);
});

test("compact mobile controls reveal touch guidance without changing the pose", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/iframe.html?id=studio-mobiletransformpad--collapsed&viewMode=story");
  const toggle = page.getByRole("button", {name: /Touch move/});
  const surface = page.getByRole("group", {name: "Two-finger transform touch area"});
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(surface).toBeHidden();
  const pose = await page.getByTestId("mobile-transform-pose").textContent();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(surface).toBeVisible();
  expect(await page.getByTestId("mobile-transform-pose").textContent()).toEqual(pose);
});


test("pinch previews bounded IFC instance scale without editing pose", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/iframe.html?id=studio-mobiletransformpad--scale&viewMode=story");
  const target = page.getByRole("group", {name: "Two-finger transform touch area"});
  await expect(target).toBeVisible();
  await target.evaluate(element => {
    const send = (name: string, id: number, x: number, y: number) =>
      element.dispatchEvent(new PointerEvent(name, {bubbles: true, pointerId: id,
        pointerType: "touch", clientX: x, clientY: y}));
    send("pointerdown", 1, 50, 180); send("pointerdown", 2, 150, 180);
    send("pointermove", 1, 25, 180); send("pointermove", 2, 175, 180);
    send("pointerup", 1, 25, 180); send("pointerup", 2, 175, 180);
  });
  const factor = JSON.parse(await page.getByTestId("mobile-transform-scale").textContent() ?? "[]");
  expect(factor).toEqual([1.5, 1.5, 1.5]);
  expect(JSON.parse(await page.getByTestId("mobile-transform-pose").textContent() ?? "{}")).toEqual({
    position: [1, 2, 3], yawRadians: 0,
  });
  await expect(page.getByTestId("mobile-transform-delta")).toContainText("Scale ALL:");
  const report = await new AxeBuilder({page}).include("#storybook-root").analyze();
  expect(report.violations).toEqual([]);
});

test("changing a move axis mid-gesture restores its pre-gesture IFC draft", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/iframe.html?id=studio-mobiletransformpad--move&viewMode=story");
  const target = page.getByRole("group", {name: "Two-finger transform touch area"});
  await expect(target).toBeVisible();
  const baseline = await page.getByTestId("mobile-transform-pose").textContent();
  await target.evaluate(element => {
    const pointer = (type: string, id: number, x: number, y: number) =>
      element.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true,
        pointerType: "touch", pointerId: id, clientX: x, clientY: y}));
    pointer("pointerdown", 1, 50, 180); pointer("pointerdown", 2, 150, 180);
    pointer("pointermove", 1, 50, 100); pointer("pointermove", 2, 150, 100);
  });
  await expect(page.getByTestId("mobile-transform-pose")).not.toHaveText(baseline ?? "");
  await page.getByRole("button", {name: "Y", exact: true}).click();
  await expect(page.getByTestId("mobile-transform-pose")).toHaveText(baseline ?? "");
  await expect(page.locator(".teldra-mobile-transform-pad__announcement")).toContainText("Previous draft restored");
  // Old contact releases cannot restart or commit a hidden gesture.
  await target.evaluate(element => {
    for (const id of [1, 2]) element.dispatchEvent(new PointerEvent("pointerup",
      {bubbles: true, pointerId: id, pointerType: "touch", clientX: 75, clientY: 120}));
  });
  await expect(page.getByTestId("mobile-transform-pose")).toHaveText(baseline ?? "");
});

test("switching modes during a pinch restores the previous mapped geometry scale", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/iframe.html?id=studio-mobiletransformpad--scale&viewMode=story");
  const target = page.getByRole("group", {name: "Two-finger transform touch area"});
  await expect(target).toBeVisible();
  await target.evaluate(element => {
    const pointer = (type: string, id: number, x: number) =>
      element.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true,
        pointerType: "touch", pointerId: id, clientX: x, clientY: 150}));
    pointer("pointerdown", 1, 50); pointer("pointerdown", 2, 150);
    pointer("pointermove", 1, 25); pointer("pointermove", 2, 175);
  });
  await expect(page.getByTestId("mobile-transform-scale")).toHaveText("[1.5,1.5,1.5]");
  await page.getByRole("group", {name: "Touch editing mode"}).getByRole("button", {name: "Rotate"}).click();
  await expect(page.getByTestId("mobile-transform-scale")).toHaveText("[1,1,1]");
  await expect(page.getByTestId("mobile-transform-pose")).toHaveText('{"position":[1,2,3],"yawRadians":0}');
  await expect(page.locator(".teldra-mobile-transform-pad__announcement")).toContainText("Previous draft restored");
});
