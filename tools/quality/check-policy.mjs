import { readFile } from "node:fs/promises";

const policy = JSON.parse(
  await readFile(new URL("../../quality/budgets.json", import.meta.url), "utf8"),
);

const fail = (message) => {
  throw new Error(`Invalid quality policy: ${message}`);
};

if (policy.schemaVersion !== "0.1.0") {
  fail("unsupported schemaVersion");
}

const release = policy.browserPolicy?.release;
if (!Array.isArray(release) || release.length === 0) {
  fail("browserPolicy.release must be a non-empty array");
}

const browsers = release.map((entry) => entry.browser);
if (new Set(browsers).size !== browsers.length) {
  fail("release browser entries must be unique");
}

for (const required of ["chrome", "edge", "firefox", "safari", "chrome-android"]) {
  if (!browsers.includes(required)) {
    fail(`missing required release browser: ${required}`);
  }
}

for (const entry of release) {
  if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) {
    fail(`${entry.browser} must declare at least one platform`);
  }
  if (!String(entry.babylonBackend).includes("webgl2")) {
    fail(`${entry.browser} must preserve Babylon WebGL2 fallback`);
  }
  if (entry.deckBackend !== "webgl2") {
    fail(
      `${entry.browser} deck.gl production backend must remain webgl2 until a new ADR promotes WebGPU`,
    );
  }
}

const positiveNumbers = {
  ...policy.assetBudgets,
  ...policy.interactionBudgets,
  ...policy.startupBudgets,
  ...policy.referenceScale,
  minimumPointerTargetCssPx:
    policy.accessibility?.minimumPointerTargetCssPx,
  preferredTouchTargetCssPx:
    policy.accessibility?.preferredTouchTargetCssPx,
};

for (const [name, value] of Object.entries(positiveNumbers)) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${name} must be a positive finite number`);
  }
}

if (policy.accessibility?.standard !== "WCAG 2.2 AA") {
  fail("accessibility standard must remain WCAG 2.2 AA");
}

if (
  policy.accessibility.preferredTouchTargetCssPx <
  policy.accessibility.minimumPointerTargetCssPx
) {
  fail("preferred touch target cannot be smaller than the minimum pointer target");
}

if (
  policy.referenceScale.minimumInteractiveFpsDesktop >
  1000 / policy.interactionBudgets.desktopTargetFrameTimeMs + 0.5
) {
  fail("desktop minimum FPS contradicts desktop frame-time target");
}

if (
  policy.referenceScale.minimumInteractiveFpsMobile >
  1000 / policy.interactionBudgets.mobileTargetFrameTimeMs + 0.5
) {
  fail("mobile minimum FPS contradicts mobile frame-time target");
}

console.log(
  `quality policy OK: ${release.length} release browser tiers, WCAG 2.2 AA, WebGL2 deck.gl baseline`,
);
