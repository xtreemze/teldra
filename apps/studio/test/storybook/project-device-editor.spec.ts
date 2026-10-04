import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("Golden Home device edit uses canonical commands, history, and persistence", async ({
  page,
}) => {
  await page.goto(
    "/iframe.html?id=studio-projectdeviceeditor--golden-home-editing&viewMode=story",
  );

  const input = page.getByRole("textbox", { name: "Device name" });
  await expect(input).toHaveValue("Living room floor lamp");
  await expect(page.getByTestId("canonical-device-name")).toHaveText(
    "Living room floor lamp",
  );
  await expect(page.getByTestId("device-canonical-id")).toHaveText(
    "device:living-room-floor-lamp",
  );
  await expect(page.getByTestId("project-dirty-state")).toHaveText("Saved");

  await input.fill("Reading lamp");
  await page.getByRole("button", { name: "Apply name" }).click();

  await expect(page.getByTestId("canonical-device-name")).toHaveText(
    "Reading lamp",
  );
  await expect(page.getByTestId("project-dirty-state")).toHaveText(
    "Unsaved changes",
  );
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Save project" })).toBeEnabled();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(input).toHaveValue("Living room floor lamp");
  await expect(page.getByTestId("canonical-device-name")).toHaveText(
    "Living room floor lamp",
  );
  await expect(page.getByTestId("project-dirty-state")).toHaveText("Saved");
  await expect(page.getByRole("button", { name: "Redo" })).toBeEnabled();

  await page.getByRole("button", { name: "Redo" }).click();
  await expect(input).toHaveValue("Reading lamp");
  await expect(page.getByTestId("project-dirty-state")).toHaveText(
    "Unsaved changes",
  );

  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByTestId("project-dirty-state")).toHaveText("Saved");
  await expect(page.getByRole("button", { name: "Save project" })).toBeDisabled();

  await expect(page.getByTestId("device-canonical-id")).toHaveText(
    "device:living-room-floor-lamp",
  );

  const accessibility = await new AxeBuilder({ page })
    .include("#storybook-root")
    .disableRules(["landmark-one-main", "page-has-heading-one"])
    .analyze();

  expect(accessibility.violations).toEqual([]);
});
