import { expect, test, type Page } from "@playwright/test";

async function certifyIdentityPicking(
  page: Page,
  storyId: string,
  expectedCanonicalId: string,
) {
  await page.goto(`/iframe.html?id=${storyId}`);

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
    expectedCanonicalId,
  );

  const clientX = Number(await projectedX.textContent());
  const clientY = Number(await projectedY.textContent());

  expect(Number.isFinite(clientX)).toBe(true);
  expect(Number.isFinite(clientY)).toBe(true);

  await page.mouse.click(clientX, clientY);

  await expect(selection).not.toHaveText("unattempted");
  await expect(selection).toHaveText(expectedCanonicalId);
}

test("loads the deterministic transport GLB and resolves canonical identity", async ({
  page,
}) => {
  await certifyIdentityPicking(
    page,
    "studio-twinviewport--identity-picking",
    "wall:fixture",
  );
});

test("loads the Blender reference GLB without identity reinterpretation", async ({
  page,
}) => {
  await certifyIdentityPicking(
    page,
    "studio-twinviewport--blender-reference-parity",
    "fixture:blender-reference",
  );
});
