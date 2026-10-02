import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/storybook",
  use: {
    baseURL: "http://127.0.0.1:6007",
    browserName: "chromium",
  },
  webServer: {
    command: "node ../../tools/storybook/serve-static.mjs storybook-static 6007",
    port: 6007,
    reuseExistingServer: true,
  },
});
