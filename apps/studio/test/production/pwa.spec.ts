import { expect, test } from "@playwright/test";

test("Studio manifest and icon family resolve from the Pages subpath", async ({ page }) => {
  await page.goto("./?launch=file");
  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestUrl).toBe("./manifest.webmanifest");
  const manifestResponse = await page.request.get(new URL(manifestUrl!, page.url()).href);
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    id: "./", scope: "./", start_url: "./", display: "standalone",
    theme_color: "#17212d",
  });
  const icons = manifest.icons as { src: string; sizes: string; purpose: string }[];
  expect(icons.some(icon => icon.sizes === "192x192")).toBe(true);
  expect(icons.some(icon => icon.sizes === "512x512" && icon.purpose === "any")).toBe(true);
  expect(icons.some(icon => icon.sizes === "512x512" && icon.purpose === "maskable")).toBe(true);
  for (const icon of icons) {
    const response = await page.request.get(new URL(icon.src, manifestResponse.url()).href);
    expect(response.ok(), icon.src).toBe(true);
  }
  expect(manifest.file_handlers[0].action).toBe("./?launch=file");
  expect(await page.getByRole("button", { name: "Try demo" }).isVisible()).toBe(true);
});

test("installed Studio can reopen the sample project with no network", async ({ page, context }) => {
  test.setTimeout(120000);
  await page.goto("./?demo=sample");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; return true; });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.getByRole("button", { name: "Try demo" }).click();
  await expect(page.getByTestId("viewport-status")).toHaveText("ready", { timeout: 90000 });
  // The synthetic archive is cached on demand, never as part of app installation.
  await page.waitForFunction(async () => {
    const cache = await caches.open("teldra-studio-demo-v1");
    return Boolean(await cache.match(new URL("./demo.teldra", location.href)));
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText("Offline", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Try demo" }).click();
  await expect(page.getByTestId("viewport-status")).toHaveText("ready", { timeout: 90000 });
  await expect(page.getByTestId("browser-project-file")).toBeVisible();
  await context.setOffline(false);
});

test("offline workers serve the current shell and retained previous lazy assets", async ({ page, context }) => {
  await page.goto("./?launch=file");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  // A second window can still request a hashed bundle from the preceding build.
  const expectedIcon = await page.evaluate(async () =>
    (await fetch(new URL("./icons/icon.svg", location.href))).text());
  await page.evaluate(async () => {
    const previous = await caches.open("teldra-studio-shell-legacy-test");
    await previous.put(new URL("./assets/old-editor-chunk.js", location.href),
      new Response("export const editorVersion = 'old';", {
        headers: { "Content-Type": "text/javascript" },
      }));
    // Same-path assets must come from the current release, never a prior build.
    await previous.put(new URL("./icons/icon.svg", location.href),
      new Response("<svg>stale icon</svg>", { headers: { "Content-Type": "image/svg+xml" } }));
  });

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole("button", { name: "Open .teldra" })).toBeVisible();
    const content = await page.evaluate(async () =>
      (await fetch(new URL("./assets/old-editor-chunk.js", location.href))).text());
    expect(content).toBe("export const editorVersion = 'old';");
    const icon = await page.evaluate(async () =>
      (await fetch(new URL("./icons/icon.svg", location.href))).text());
    expect(icon).toBe(expectedIcon);
    await context.setOffline(false);
    await page.goto("./third-party-notices.html");
    await expect(page.getByRole("heading", { name: "Third-party notices" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
