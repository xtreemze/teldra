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
