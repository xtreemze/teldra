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


test("scale gizmo mode supports local XYZ factors and cancel restores the source", async ({page}) => {
  await page.goto(story);
  await expect(page.getByTestId("gizmo-status")).toHaveText("ready");
  await page.getByRole("button",{name:"Scale",exact:true}).click();
  await expect(page.getByTestId("gizmo-scale")).toHaveText("1,1,1");
  await page.getByRole("button",{name:"Set scale XYZ",exact:true}).click();
  await expect(page.getByTestId("gizmo-scale")).toHaveText("1.5,1,0.75");
  await page.getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(page.getByTestId("gizmo-scale")).toHaveText("1,1,1");
});


test("a persisted upright IFC affine shear preserves pickability and can be reset", async ({page}) => {
  const errors: string[] = [];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(story);
  await expect(page.getByTestId("gizmo-status")).toHaveText("ready");
  const before = JSON.parse(await page.getByTestId("gizmo-pickpoint").textContent() ?? "null");
  expect(before).not.toBeNull();
  await page.getByRole("button",{name:"Project affine shear",exact:true}).click();
  await expect(page.getByTestId("gizmo-affine")).toHaveText("projected");
  const after = JSON.parse(await page.getByTestId("gizmo-pickpoint").textContent() ?? "null");
  expect(after).not.toBeNull();
  await page.getByRole("button",{name:"Reset affine",exact:true}).click();
  await expect(page.getByTestId("gizmo-affine")).toHaveText("source");
  const restored = JSON.parse(await page.getByTestId("gizmo-pickpoint").textContent() ?? "null");
  expect(restored).not.toBeNull();
  expect(restored.clientX).toBeCloseTo(before.clientX,2);
  expect(restored.clientY).toBeCloseTo(before.clientY,2);
  expect(errors).toEqual([]);
});
