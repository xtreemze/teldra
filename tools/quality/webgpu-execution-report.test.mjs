import {test} from "node:test";
import assert from "node:assert/strict";
import {assertCompleteRendererRun} from "./webgpu-execution-report.mjs";
const commit="a".repeat(40);
function passing() {return {config:{metadata:{scope:"synthetic-renderer-regressions",requiredBackend:"webgpu",sourceCommit:commit,freshBundle:true}},suites:[{specs:[{tests:[{expectedStatus:"passed",results:[{status:"passed"}]}]}]}],stats:{expected:1,skipped:0,unexpected:0,flaky:0},errors:[]};}
test("accepts a completed owned-build execution",()=>assert.doesNotThrow(()=>assertCompleteRendererRun(passing(),commit)));
test("rejects skipped and empty runs even if the test process exited successfully",()=>{
 const skipped=passing();skipped.stats.expected=0;skipped.stats.skipped=1;skipped.suites[0].specs[0].tests[0].results[0].status="skipped";
 assert.throws(()=>assertCompleteRendererRun(skipped,commit),/no skips/);
 const empty=passing();empty.suites=[];empty.stats.expected=0;
 assert.throws(()=>assertCompleteRendererRun(empty,commit),/passing tests/);
});
test("rejects expected failures and flaky retries",()=>{
 const failure=passing();failure.suites[0].specs[0].tests[0].expectedStatus="failed";failure.suites[0].specs[0].tests[0].results[0].status="failed";
 assert.throws(()=>assertCompleteRendererRun(failure,commit),/actually pass/);
 const flaky=passing();flaky.stats.flaky=1;
 assert.throws(()=>assertCompleteRendererRun(flaky,commit),/no skips/);
});
test("rejects stale source, missing fresh build and wrong backend metadata",()=>{
 for(const [key,value]of [["sourceCommit","b".repeat(40)],["freshBundle",false],["requiredBackend","webgl"]]) {
  const report=passing();report.config.metadata[key]=value;
  assert.throws(()=>assertCompleteRendererRun(report,commit),/owned source build/);
 }
});
