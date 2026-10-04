import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const deviceId = "device:living-room-floor-lamp";

test("shares canonical selection across Babylon and the device inspector without dirtying selection", async ({
  page,
}) => {
  await page.goto(
    "/iframe.html?id=studio-studioworkspace--canonical-selection&viewMode=story",
  );

  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await expect(page.getByTestId("workspace-dirty-state")).toHaveText("Saved");
  await expect(page.getByTestId("workspace-revision")).toHaveText("0");
  await expect(page.getByTestId("studio-selected-canonical-id")).toHaveText(
    "none",
  );

  const projectedX = page.getByTestId("workspace-projected-client-x");
  const projectedY = page.getByTestId("workspace-projected-client-y");
  await expect(projectedX).not.toHaveText("pending");
  await expect(projectedY).not.toHaveText("pending");

  const clientX = Number(await projectedX.textContent());
  const clientY = Number(await projectedY.textContent());
  expect(Number.isFinite(clientX)).toBe(true);
  expect(Number.isFinite(clientY)).toBe(true);

  await page.mouse.click(clientX, clientY);

  await expect(page.getByTestId("studio-selected-canonical-id")).toHaveText(
    "wall:fixture",
  );
  await expect(page.getByTestId("selected-canonical-id")).toHaveText(
    "wall:fixture",
  );
  await expect(page.getByTestId("studio-selection-kind")).toContainText(
    "not editable as a twin device",
  );
  await expect(page.getByTestId("workspace-dirty-state")).toHaveText("Saved");
  await expect(page.getByTestId("workspace-revision")).toHaveText("0");

  await page.locator(`[data-device-id="${deviceId}"]`).click();

  await expect(page.getByTestId("studio-selected-canonical-id")).toHaveText(
    deviceId,
  );
  await expect(page.getByTestId("selected-canonical-id")).toHaveText(deviceId);
  await expect(page.getByTestId("device-canonical-id")).toHaveText(deviceId);
  await expect(page.getByTestId("workspace-dirty-state")).toHaveText("Saved");
  await expect(page.getByTestId("workspace-revision")).toHaveText("0");

  const input = page.getByRole("textbox", { name: "Device name" });
  await expect(input).toHaveValue("Living room floor lamp");

  await input.fill("Reading lamp");
  await page.getByRole("button", { name: "Apply name" }).click();

  await expect(page.getByTestId("studio-selected-canonical-id")).toHaveText(
    deviceId,
  );
  await expect(page.getByTestId("workspace-dirty-state")).toHaveText(
    "Unsaved changes",
  );
  await expect(page.getByTestId("workspace-revision")).toHaveText("1");
  await expect(page.locator(`[data-device-id="${deviceId}"]`)).toContainText(
    "Reading lamp",
  );

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("studio-selected-canonical-id")).toHaveText(
    deviceId,
  );
  await expect(input).toHaveValue("Living room floor lamp");
  await expect(page.getByTestId("workspace-dirty-state")).toHaveText("Saved");

  await page.getByRole("button", { name: "Redo" }).click();
  await expect(input).toHaveValue("Reading lamp");
  await expect(page.getByTestId("studio-selected-canonical-id")).toHaveText(
    deviceId,
  );

  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByTestId("workspace-dirty-state")).toHaveText("Saved");
  await expect(page.getByTestId("device-canonical-id")).toHaveText(deviceId);

  const accessibility = await new AxeBuilder({ page })
    .include("#storybook-root")
    .disableRules(["landmark-one-main", "page-has-heading-one"])
    .analyze();

  expect(accessibility.violations).toEqual([]);
});
