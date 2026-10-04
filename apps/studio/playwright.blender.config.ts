import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/blender-reference",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:6007",
    browserName: "chromium",
    viewport: {
      width: 900,
      height: 640,
    },
  },
  webServer: {
    command: "node ../../tools/storybook/serve-static.mjs storybook-static 6007",
    port: 6007,
    reuseExistingServer: false,
  },
});
