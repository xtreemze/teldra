import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("opens, edits, undoes, redoes, and saves the browser project shell", async ({
  page,
}) => {
  await page.goto(
    "/iframe.html?id=studio-browserprojectstudio--golden-home&viewMode=story",
  );

  await page.getByRole("button", { name: "Open .teldra" }).click();

  await expect(page.getByTestId("browser-project-file")).toHaveText(
    "golden-home.teldra",
  );
  await expect(page.getByTestId("device-canonical-id")).toHaveText(
    "device:living-room-floor-lamp",
  );

  const name = page.getByLabel("Device name");
  await name.fill("Reading lamp");
  await page.getByRole("button", { name: "Apply name" }).click();

  await expect(page.getByTestId("canonical-device-name")).toHaveText(
    "Reading lamp",
  );
  await expect(page.getByTestId("project-dirty-state")).toHaveText(
    "Unsaved changes",
  );

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("canonical-device-name")).toHaveText(
    "Living room floor lamp",
  );

  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.getByTestId("canonical-device-name")).toHaveText(
    "Reading lamp",
  );

  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByTestId("project-dirty-state")).toHaveText("Saved");

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("unsupported browsers get a non-destructive fallback", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=studio-browserprojectstudio--unsupported-browser&viewMode=story",
  );

  await expect(
    page.getByRole("heading", { name: "Direct local editing unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open .teldra" })).toBeDisabled();
  await expect(page.getByText("No project data has been changed.")).toBeVisible();
});
