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
  await expect(page.getByRole("status")).toContainText("Apply placement");
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
