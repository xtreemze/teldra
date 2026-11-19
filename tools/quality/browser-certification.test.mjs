import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserCertification, evaluateBrowserCertification } from "./browser-certification.mjs";

const policy = JSON.parse(readFileSync(new URL("../../quality/budgets.json", import.meta.url), "utf8"));
const sha = "a".repeat(40);
const fixtureSha = "b".repeat(64);
function evidence(platform) {
  const mobile = ["android", "ios", "ipados"].includes(platform);
  return {
    kind: "real-browser", testedAt: "2026-11-19T00:00:00Z",
    browserVersion: "1.2.3", osVersion: "1.2", hardware: "Reference device",
    gpu: "Reference GPU", rendererVersion: "1.0", viewport: {width: 390, height: 844, dpr: 2},
    projectSha256: fixtureSha, evidenceRef: "release-evidence/run.json",
    metrics: {frameMedianMs: 12, frameP95Ms: 18, selectionP95Ms: 25, cameraInputP95Ms: 25, liveStateToVisualP95Ms: 50,
      cachedStartupMs: 1500, coldStartupMs: 3500, interactiveFps: 60},
    checks: {navigation: "pass", canonicalEditing: "pass", accessibility: "pass", performance: "pass",
      ...(mobile ? {touch: "pass", feedback: "pass", pwa: "pass"} : {})},
  };
}

test("matrix derives every supported platform and rolling channel; starts untested", () => {
  const report = createBrowserCertification(policy, sha);
  assert.equal(report.rows.length, 17);
  const result = evaluateBrowserCertification(policy, report, sha);
  assert.equal(result.errors.length, 0);
  assert.equal(result.ready, false);
  assert.equal(result.blockers.length, 34);
});

test("current commit and complete physical evidence are required", () => {
  const report = createBrowserCertification(policy, sha);
  for (const row of report.rows) {
    row.webgl2 = {status: "pass", evidence: evidence(row.platform)};
    row.webgpu = {status: "unavailable", evidence: {...evidence(row.platform), reason: "GPU capability probe unavailable"}};
  }
  assert.equal(evaluateBrowserCertification(policy, report, sha).ready, true);
  assert.equal(evaluateBrowserCertification(policy, report, "c".repeat(40)).ready, false);
  rowFailure(report);
  assert.equal(evaluateBrowserCertification(policy, report, sha).ready, false);
});

function rowFailure(report) {
  report.rows[0].webgl2.evidence.kind = "playwright";
}
test("missing rows, duplicates, unknown rows, and WebGL2 unavailable cannot certify", () => {
  const report = createBrowserCertification(policy, sha);
  report.rows.pop();
  report.rows.push({...report.rows[0]});
  report.rows[0].webgl2 = {status: "unavailable", evidence: {...evidence("windows"),reason:"No GPU"}};
  const result = evaluateBrowserCertification(policy, report, sha);
  assert.ok(result.errors.length >= 3);
  assert.equal(result.ready, false);
});
test("mobile evidence requires actual touch, feedback and PWA checks", () => {
  const report = createBrowserCertification(policy, sha);
  const mobile = report.rows.find(row => row.platform === "android");
  mobile.webgl2 = {status:"pass",evidence:evidence("android")};
  delete mobile.webgl2.evidence.checks.feedback;
  assert.ok(evaluateBrowserCertification(policy, report, sha).errors.some(e => e.includes("feedback")));
});

test("measured budget violations block an otherwise certified release", () => {
  const report = createBrowserCertification(policy, sha);
  for (const row of report.rows) {
    row.webgl2 = {status:"pass", evidence:evidence(row.platform)};
    row.webgpu = {status:"unavailable", evidence:{...evidence(row.platform),reason:"Capability probe unavailable"}};
  }
  report.rows[0].webgl2.evidence.metrics.selectionP95Ms = 51;
  const result = evaluateBrowserCertification(policy, report, sha);
  assert.equal(result.errors.length, 0);
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some(e => e.includes("selectionP95Ms exceeds budget")));
});

test("untested baseline is valid data but never release evidence", () => {
  const report = JSON.parse(readFileSync(new URL("../../quality/browser-certification.json", import.meta.url), "utf8"));
  assert.deepEqual(report, createBrowserCertification(policy));
  const result = evaluateBrowserCertification(policy, report, sha);
  assert.equal(result.errors.length, 0);
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some(line => line.includes("exact requested release commit")));
});
