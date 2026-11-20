import {defineConfig} from "@playwright/test";

const browserName = process.env.TELDRA_COMPAT_BROWSER;
if (browserName !== "firefox" && browserName !== "webkit") {
  throw new Error("Set TELDRA_COMPAT_BROWSER to firefox or webkit for cross-engine CI");
}

export default defineConfig({
  testDir: "./test/compatibility",
  timeout: 90_000,
  expect: {timeout: 30_000},
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", {outputFile: `test-results/compatibility-${browserName}.json`}]],
  use: {
    browserName,
    baseURL: "http://127.0.0.1:4174/teldra/studio/",
    viewport: {width: 390, height: 844},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node ../../tools/site/serve-pages.mjs 4174",
    port: 4174,
    reuseExistingServer: false,
  },
});
