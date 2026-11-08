import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/storybook",
  use: {
    baseURL: "http://127.0.0.1:6006",
    browserName: "chromium",
    ...(process.env.TELDRA_BROWSER_EXECUTABLE ? {launchOptions:{executablePath:process.env.TELDRA_BROWSER_EXECUTABLE}} : {}),
  },
  webServer: {
    command: "node ../../tools/storybook/serve-static.mjs storybook-static 6006",
    port: 6006,
    reuseExistingServer: true,
  },
});
