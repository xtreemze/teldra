import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("shares canonical selection between viewport and device inspector without dirtying the project", async ({
  page,
}) => {
  await page.goto(
    "/iframe.html?id=studio-selectionworkspace--golden-home&viewMode=story",
  );

  await expect(page.getByTestId("viewport-status")).toHaveText("ready");

  const projectedX = page.getByTestId("workspace-projected-x");
  const projectedY = page.getByTestId("workspace-projected-y");
  await expect(projectedX).not.toHaveText("pending");
  await expect(projectedY).not.toHaveText("pending");

  const clientX = Number(await projectedX.textContent());
  const clientY = Number(await projectedY.textContent());
  await page.mouse.click(clientX, clientY);

  await expect(page.getByTestId("workspace-selected-canonical-id")).toHaveText(
    "wall:fixture",
  );
  await expect(page.getByTestId("workspace-selection-kind")).toHaveText(
    "Building / scene entity",
  );
  await expect(page.getByTestId("project-dirty-state")).toHaveCount(0);

  await page
    .getByRole("list", { name: "Devices", exact: true }).getByRole("button", { name: /Living room floor lamp/ })
    .click();

  await expect(page.getByTestId("workspace-selected-canonical-id")).toHaveText(
    "device:living-room-floor-lamp",
  );
  await expect(page.getByTestId("device-canonical-id")).toHaveText(
    "device:living-room-floor-lamp",
  );
  await expect(page.getByTestId("project-dirty-state")).toHaveText("Saved");
  await expect(
    page.getByTestId("live-availability-capability:living-room-floor-lamp:light"),
  ).toHaveText("online");
  await expect(page.getByTestId("live-value-power")).toHaveText("on");
  await expect(page.getByTestId("live-value-brightness")).toHaveText(
    `${128 / 255} ratio`,
  );
  await expect(page.getByTestId("live-value-color")).toHaveText(
    `1, ${128 / 255}, 0`,
  );

  await page.getByTestId("inject-live-unavailable").click();
  await expect(
    page.getByTestId("live-availability-capability:living-room-floor-lamp:light"),
  ).toHaveText("unavailable");
  await expect(page.getByTestId("live-value-power")).toHaveText("on");
  await expect(page.getByTestId("project-dirty-state")).toHaveText("Saved");

  const input = page.getByRole("textbox", { name: "Device name" });
  await input.fill("Reading lamp");
  await page.getByRole("button", { name: "Apply name" }).click();

  await expect(page.getByTestId("canonical-device-name")).toHaveText(
    "Reading lamp",
  );
  await expect(page.getByTestId("workspace-selected-canonical-id")).toHaveText(
    "device:living-room-floor-lamp",
  );
  await expect(page.getByTestId("device-canonical-id")).toHaveText(
    "device:living-room-floor-lamp",
  );
  await expect(
    page.getByTestId("live-availability-capability:living-room-floor-lamp:light"),
  ).toHaveText("unavailable");
  await expect(page.getByTestId("live-value-power")).toHaveText("on");
  await expect(page.getByTestId("project-dirty-state")).toHaveText(
    "Unsaved changes",
  );

  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByTestId("project-dirty-state")).toHaveText("Saved");

  const accessibility = await new AxeBuilder({ page })
    .include("#storybook-root")
    .disableRules(["landmark-one-main", "page-has-heading-one"])
    .analyze();

  expect(accessibility.violations).toEqual([]);
});

test("three-finger gestures use canonical project history and keep numeric editing intact", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/iframe.html?id=studio-selectionworkspace--golden-home&viewMode=story");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");

  await page.getByRole("button", {name: "Scene", exact: true}).click();
  await page.getByRole("list", {name: "Devices", exact: true})
    .getByRole("button", {name: /Living room floor lamp/}).click();
  await page.getByRole("group", {name: "Mobile selection actions"})
    .getByRole("button", {name: "Details"}).click();
  const name = page.getByRole("textbox", {name: "Device name"});
  const original = await name.inputValue();
  await name.fill("Gesture history test");
  await page.getByRole("button", {name: "Apply name"}).click();
  await expect(page.getByTestId("canonical-device-name")).toHaveText("Gesture history test");

  const swipe = async (direction: -1 | 1) => {
    await page.getByTestId("twin-canvas").evaluate((canvas, sign) => {
      const pointer = (type: string, id: number, x: number) =>
        canvas.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true,
          pointerType: "touch", pointerId: id, clientX: x, clientY: 440}));
      for (const [id, x] of [[1, 125], [2, 195], [3, 265]]) pointer("pointerdown", id, x);
      for (const [id, x] of [[1, 125], [2, 195], [3, 265]]) pointer("pointermove", id, x + 100 * sign);
      for (const [id, x] of [[1, 125], [2, 195], [3, 265]]) pointer("pointerup", id, x + 100 * sign);
    }, direction);
  };
  await swipe(-1);
  await expect(page.getByTestId("canonical-device-name")).toHaveText(original);
  await expect(page.getByTestId("transform-shortcut-status")).toContainText("Undid");
  await swipe(1);
  await expect(page.getByTestId("canonical-device-name")).toHaveText("Gesture history test");
  await expect(page.getByTestId("transform-shortcut-status")).toContainText("Redid");

  await page.getByRole("button", {name: "Project", exact: true}).click();
  await page.getByRole("button", {name: "Touch gesture guide"}).click();
  await expect(page.getByRole("group", {name: "Mobile touch gesture guide"})).toContainText("three fingers");
});


test("browser scene rebake is opt-in, blocks dirty IFC edits and reports exported copy", async ({page}) => {
  await page.goto("/iframe.html?id=studio-selectionworkspace--rebuild-copy&viewMode=story");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  const button=page.getByRole("group",{name:"Project actions"})
    .getByRole("button",{name:"Rebuild 3D copy"});
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId("workspace-rebake-count")).toHaveText("1");
  await expect(page.getByTestId("transform-shortcut-status")).toContainText("separate validated");

  await page.getByRole("list",{name:"Devices",exact:true})
    .getByRole("button",{name:/Living room floor lamp/}).click();
  await page.getByRole("textbox",{name:"Device name"}).fill("Modified for rebake");
  await page.getByRole("button",{name:"Apply name"}).click();
  await expect(button).toBeDisabled();
  await page.getByRole("group",{name:"Project actions"}).getByRole("button",{name:"Save project"}).click();
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId("workspace-rebake-count")).toHaveText("2");
});

test("mobile project actions expose a protected rebake-copy operation", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto("/iframe.html?id=studio-selectionworkspace--rebuild-copy&viewMode=story");
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await page.getByRole("button",{name:"Project",exact:true}).click();
  const mobile=page.getByRole("group",{name:"Mobile project menu"})
    .getByRole("button",{name:"Rebuild 3D copy"});
  await expect(mobile).toBeEnabled();
  await mobile.click();
  await expect(page.getByTestId("workspace-rebake-count")).toHaveText("1");
});
