/** Machine-readable release evidence, independent of simulated-browser CI. */
const CHANNELS = Object.freeze({
  "current-and-previous-major": ["current", "previous"],
  "current-stable-and-extended-stable": ["stable", "extended-stable"],
  "current-stable": ["stable"],
  "current-major": ["current"],
});
const BACKENDS = ["webgl2", "webgpu"];
const MOBILE = new Set(["android", "ios", "ipados"]);
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const rowKey = (row) => [row.browser, row.platform, row.channel].join("/");
const requiredChecks = (platform) => [
  "navigation", "canonicalEditing", "accessibility", "performance",
  ...(MOBILE.has(platform) ? ["touch", "feedback", "pwa"] : []),
];

export function createBrowserCertification(policy, sourceCommit = null) {
  const rows = policy.browserPolicy.release.flatMap((tier) => {
    const channels = CHANNELS[tier.versions];
    if (!channels) throw new Error("Unsupported browser channel policy: " + tier.versions);
    return tier.platforms.flatMap((platform) => channels.map((channel) => ({
      browser: tier.browser,
      platform,
      channel,
      webgl2: {status: "not-tested"},
      webgpu: {status: "not-tested"},
    })));
  });
  return {schemaVersion: "0.1.0", sourceCommit, rows};
}

/**
 * Validate the matrix and distinguish structural errors from release blockers.
 * A real-browser declaration is a reviewer assertion, not a hardware detector.
 * CI must never populate it from synthetic pointer or Playwright engine tests.
 */
export function evaluateBrowserCertification(policy, report, expectedCommit) {
  const errors = [];
  const blockers = [];
  const expected = createBrowserCertification(policy).rows;
  const expectedKeys = new Set(expected.map(rowKey));
  const seen = new Set();
  if (!object(report) || report.schemaVersion !== "0.1.0" || !Array.isArray(report.rows)) {
    return {ready: false, errors: ["Invalid report schema or rows"], blockers};
  }
  if (report.sourceCommit !== null && (typeof report.sourceCommit !== "string" || !SHA.test(report.sourceCommit))) {
    errors.push("sourceCommit must be null or a full Git commit SHA");
  }
  if (!expectedCommit || !SHA.test(expectedCommit) || report.sourceCommit !== expectedCommit) {
    blockers.push("Certification is not bound to the exact requested release commit");
  }
  for (const row of report.rows) {
    if (!object(row)) { errors.push("Invalid matrix row"); continue; }
    const key = rowKey(row);
    if (!expectedKeys.has(key)) errors.push("Unexpected browser row: " + key);
    if (seen.has(key)) errors.push("Duplicate browser row: " + key);
    seen.add(key);
    for (const backend of BACKENDS) {
      const label = key + "/" + backend;
      const result = row[backend];
      if (!object(result) || !["not-tested", "pass", "fail", "unavailable"].includes(result.status)) {
        errors.push(label + ": invalid or missing status");
        continue;
      }
      if (result.status === "not-tested") {
        if (result.evidence !== undefined) errors.push(label + ": not-tested must not contain evidence");
        blockers.push(label + ": not tested");
        continue;
      }
      if (result.status === "fail") blockers.push(label + ": failed");
      if (result.status === "unavailable" && backend !== "webgpu") {
        errors.push(label + ": WebGL2 fallback cannot be waived");
      }
      const evidence = result.evidence;
      if (!object(evidence)) { errors.push(label + ": missing evidence"); continue; }
      if (evidence.kind !== "real-browser") errors.push(label + ": requires real-browser evidence, not an engine simulation");
      for (const field of ["browserVersion", "osVersion", "hardware", "gpu", "rendererVersion", "evidenceRef"]) {
        if (!nonempty(evidence[field])) errors.push(label + ": missing " + field);
      }
      if (!nonempty(evidence.testedAt) || !Number.isFinite(Date.parse(evidence.testedAt))) {
        errors.push(label + ": missing valid test timestamp");
      }
      if (typeof evidence.projectSha256 !== "string" || !SHA256.test(evidence.projectSha256)) {
        errors.push(label + ": missing reference project SHA-256");
      }
      const v = evidence.viewport;
      if (!object(v) || !["width", "height", "dpr"].every(field => Number.isFinite(v[field]) && v[field] > 0)) {
        errors.push(label + ": missing measured viewport and DPR");
      }
      if (result.status === "unavailable") {
        if (!nonempty(evidence.reason)) errors.push(label + ": WebGPU unavailability requires documented capability evidence");
        continue;
      }
      for (const check of requiredChecks(row.platform)) {
        const status = evidence.checks?.[check];
        if (!["pass", "fail", "not-tested"].includes(status)) errors.push(label + ": missing " + check + " check");
        else if (status !== "pass") blockers.push(label + ": " + check + " " + status);
      }
      if (result.status === "pass") {
        const mobile = MOBILE.has(row.platform);
        const thresholds = policy.interactionBudgets;
        const startup = policy.startupBudgets;
        const metrics = evidence.metrics;
        const maxima = {
          frameMedianMs: mobile ? thresholds.mobileTargetFrameTimeMs : thresholds.desktopTargetFrameTimeMs,
          selectionP95Ms: thresholds.selectionP95Ms,
          cameraInputP95Ms: thresholds.cameraInputP95Ms,
          cachedStartupMs: mobile ? startup.referenceMobileCachedProjectInteractiveMs : startup.referenceDesktopCachedProjectInteractiveMs,
          ...(!mobile ? {coldStartupMs: startup.referenceDesktopColdProjectInteractiveMs} : {}),
        };
        for (const [field, maximum] of Object.entries(maxima)) {
          if (!Number.isFinite(metrics?.[field]) || metrics[field] < 0) errors.push(label + ": missing measured " + field);
          else if (metrics[field] > maximum) blockers.push(label + ": " + field + " exceeds budget");
        }
        if (!Number.isFinite(metrics?.frameP95Ms) || metrics.frameP95Ms < (metrics.frameMedianMs ?? 0)) {
          errors.push(label + ": missing or inconsistent frameP95Ms");
        }
        const minFps = mobile ? policy.referenceScale.minimumInteractiveFpsMobile : policy.referenceScale.minimumInteractiveFpsDesktop;
        if (!Number.isFinite(metrics?.interactiveFps) || metrics.interactiveFps <= 0) errors.push(label + ": missing measured interactiveFps");
        else if (metrics.interactiveFps < minFps) blockers.push(label + ": interactiveFps below budget");
      }
    }
  }
  for (const key of expectedKeys) if (!seen.has(key)) errors.push("Missing browser row: " + key);
  return {ready: errors.length === 0 && blockers.length === 0, errors, blockers};
}
