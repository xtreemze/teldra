import { expect, test } from "@playwright/test";
import { join } from "node:path";

const canonicalId = "fixture:blender-reference-cube";

test("loads Blender GLB through Babylon and preserves pick identity", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto(
    "/iframe.html?id=certification-blenderreference--generated",
  );

  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await expect(page.getByTestId("viewport-backend")).toHaveText(/webgpu|webgl/);

  const projectedX = page.getByTestId("blender-reference-x");
  const projectedY = page.getByTestId("blender-reference-y");
  await expect(projectedX).not.toHaveText("pending");
  await expect(projectedY).not.toHaveText("pending");
  await expect(page.getByTestId("blender-reference-roundtrip")).toHaveText(
    canonicalId,
  );

  const clientX = Number(await projectedX.textContent());
  const clientY = Number(await projectedY.textContent());
  expect(Number.isFinite(clientX)).toBe(true);
  expect(Number.isFinite(clientY)).toBe(true);

  await page.mouse.click(clientX, clientY);
  await expect(page.getByTestId("selected-canonical-id")).toHaveText(canonicalId);

  const outputDir = process.env.TELDRA_BLENDER_OUTPUT;
  if (outputDir === undefined || outputDir.length === 0) {
    throw new Error("TELDRA_BLENDER_OUTPUT is required for certification");
  }

  await page.getByTestId("twin-canvas").screenshot({
    path: join(outputDir, "reference-babylon.png"),
  });

  expect(browserErrors).toEqual([]);
});
