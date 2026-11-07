import { expect, test } from "@playwright/test";

const story = "/iframe.html?id=studio-furnituregizmodiagnostic--translation-and-rotation&viewMode=story";
test("translation handle stages a pose and cancel restores the rendered source", async ({page}) => {
  await page.goto(story); await expect(page.getByTestId("gizmo-status")).toHaveText("ready");
  const baseline = JSON.parse(await page.getByTestId("gizmo-pickpoint").textContent() ?? "null");
  const box = await page.getByTestId("gizmo-canvas").boundingBox(); if (!box) throw new Error("No canvas");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.mouse.move(box.x+box.width/2-28,box.y+box.height/2);
  await page.mouse.down(); await page.mouse.move(box.x+box.width/2-83,box.y+box.height/2,{steps:12}); await page.mouse.up();
  await expect(page.getByTestId("gizmo-drag")).toHaveText("ended");
  expect(JSON.parse(await page.getByTestId("gizmo-pose").textContent() ?? "{}").position[0]).toBeGreaterThan(.2);
  await page.getByRole("button",{name:"Cancel",exact:true}).click();
  const restored = JSON.parse(await page.getByTestId("gizmo-pickpoint").textContent() ?? "null");
  expect(restored.clientX).toBeCloseTo(baseline.clientX,2); expect(restored.clientY).toBeCloseTo(baseline.clientY,2);
});
test("upright rotation ring stages a world-Z yaw", async ({page}) => {
  await page.goto(story); await expect(page.getByTestId("gizmo-status")).toHaveText("ready");
  await page.getByRole("button",{name:"Rotate",exact:true}).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await page.getByTestId("gizmo-canvas").boundingBox(); if (!box) throw new Error("No canvas");
  const x=box.x+box.width/2,y=box.y+box.height/2;
  await page.mouse.move(x+47,y+2); await page.mouse.down();
  await page.mouse.move(x+30,y+17,{steps:12}); await page.mouse.move(x,y+23,{steps:12}); await page.mouse.up();
  await expect(page.getByTestId("gizmo-drag")).toHaveText("ended");
  expect(Math.abs(JSON.parse(await page.getByTestId("gizmo-pose").textContent() ?? "{}").yawRadians)).toBeGreaterThan(.5);
});
