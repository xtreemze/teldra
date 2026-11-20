import { defineConfig } from "@playwright/test";

const ownedPort = process.env.TELDRA_RENDERER_PORT;
const port = ownedPort ? Number(ownedPort) : 6006;
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid renderer test port");
export default defineConfig({
  ...(ownedPort ? {outputDir:"test-results/webgpu-run"} : {}),
  testDir: "./test/storybook",
  metadata: process.env.TELDRA_REQUIRE_WEBGPU === "1" ? {
    scope: "synthetic-renderer-regressions",
    requiredBackend: "webgpu",
    sourceCommit: process.env.TELDRA_RENDERER_SOURCE_COMMIT ?? "unrecorded",
    freshBundle: process.env.TELDRA_RENDERER_FRESH_BUNDLE === "1",
    worktreeDirty: process.env.TELDRA_RENDERER_WORKTREE_DIRTY !== "0",
  } : {},
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    ...(process.env.TELDRA_BROWSER_EXECUTABLE ? {launchOptions:{executablePath:process.env.TELDRA_BROWSER_EXECUTABLE}} : {}),
  },
  webServer: {
    command: `node ../../tools/storybook/serve-static.mjs ${ownedPort ? "test-results/webgpu-storybook" : "storybook-static"} ${port}`,
    port,
    reuseExistingServer: !ownedPort,
  },
});
