/** Validate execution completeness, not physical-device authenticity or release certification. */
export function assertCompleteRendererRun(report, expectedCommit) {
  const metadata = report.config?.metadata;
  if (metadata?.requiredBackend !== "webgpu" || metadata?.scope !== "synthetic-renderer-regressions" ||
      metadata?.sourceCommit !== expectedCommit || metadata?.freshBundle !== true) {
    throw new Error("Renderer execution metadata does not match the owned source build");
  }
  const collect = suites => suites.flatMap(suite => [
    ...(suite.specs ?? []).flatMap(spec => spec.tests ?? []), ...collect(suite.suites ?? []),
  ]);
  const tests = collect(report.suites ?? []);
  const stats = report.stats;
  if (!tests.length || !stats || stats.expected !== tests.length || stats.skipped !== 0 ||
      stats.unexpected !== 0 || stats.flaky !== 0 || (report.errors ?? []).length) {
    throw new Error("Renderer execution must contain passing tests with no skips, failures or flakes");
  }
  if (tests.some(test => test.expectedStatus !== "passed" || !test.results?.length ||
      test.results.some(result => result.status !== "passed"))) {
    throw new Error("Every renderer test must actually pass; expected failures are not certification");
  }
}
