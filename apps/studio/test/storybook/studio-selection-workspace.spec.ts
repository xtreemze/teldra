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
    .getByRole("button", { name: /Living room floor lamp/ })
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


test("dispatches authorized light power only through the semantic Studio control without dirtying canonical state", async ({
  page,
}) => {
  await page.goto(
    "/iframe.html?id=studio-selectionworkspace--authorized-light-control&viewMode=story",
  );

  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await expect(page.getByTestId("workspace-selected-canonical-id")).toHaveText(
    "device:living-room-floor-lamp",
  );
  await expect(
    page.getByTestId("live-availability-capability:living-room-floor-lamp:light"),
  ).toHaveText("online");

  const power = page.getByRole("button", { name: "Power" });
  await expect(power).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("project-dirty-state")).toHaveText("Saved");

  await power.click();

  await expect(power).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("project-dirty-state")).toHaveText("Saved");

  const serviceCall = page.getByTestId("story-last-service-call");
  await expect(serviceCall).toContainText('"type":"call_service"');
  await expect(serviceCall).toContainText('"domain":"light"');
  await expect(serviceCall).toContainText('"service":"turn_off"');
  await expect(serviceCall).toContainText(
    '"entity_id":"light.living_room_floor_lamp"',
  );

  const accessibility = await new AxeBuilder({ page })
    .include("#storybook-root")
    .disableRules(["landmark-one-main", "page-has-heading-one"])
    .analyze();

  expect(accessibility.violations).toEqual([]);
});
