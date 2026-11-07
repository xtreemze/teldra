import { expect, test } from "@playwright/test";

test("failed, overlapping and disposed loads leave no published scene", async ({page}) => {
  await page.goto("/iframe.html?id=studio-rendererlifecycle--failure-and-disposal");
  await expect(page.getByTestId("lifecycle-result")).toHaveText(JSON.stringify({
    overlap: "rejected", failed: "rejected", repeated: "rejected", meshParts: 0,
    layers: 0, disposed: "rejected",
  }));
});
