import { expect, test } from "@playwright/test";

test("loads the GLB and resolves a picked render node to canonical identity", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=studio-twinviewport--identity-picking");

  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await expect(page.getByTestId("viewport-backend")).toHaveText(/webgpu|webgl/);

  const canvas = page.getByTestId("twin-canvas");
  await expect(canvas).toBeVisible();

  const selection = page.getByTestId("selected-canonical-id");
  await expect(selection).toHaveText("unattempted");

  const projectedX = page.getByTestId("projected-client-x");
  const projectedY = page.getByTestId("projected-client-y");

  await expect(projectedX).not.toHaveText("pending");
  await expect(projectedY).not.toHaveText("pending");
  await expect(page.getByTestId("projected-roundtrip-id")).toHaveText(
    "wall:fixture",
  );

  const clientX = Number(await projectedX.textContent());
  const clientY = Number(await projectedY.textContent());

  expect(Number.isFinite(clientX)).toBe(true);
  expect(Number.isFinite(clientY)).toBe(true);

  await page.mouse.click(clientX, clientY);

  await expect(selection).not.toHaveText("unattempted");
  await expect(selection).toHaveText("wall:fixture");
});
