import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createBrowserCertification, evaluateBrowserCertification } from "./browser-certification.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const policy = JSON.parse(readFileSync(new URL("../../quality/budgets.json", import.meta.url), "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"}).trim();
if (process.argv.includes("--template")) {
  console.log(JSON.stringify(createBrowserCertification(policy, commit), null, 2));
} else {
  const path = process.env.TELDRA_BROWSER_CERTIFICATION_REPORT ??
    new URL("../../quality/browser-certification.json", import.meta.url);
  const report = JSON.parse(readFileSync(path, "utf8"));
  const result = evaluateBrowserCertification(policy, report, commit);
  if (result.errors.length) {
    for (const error of result.errors) console.error("Invalid certification: " + error);
    process.exitCode = 1;
  }
  const release = process.argv.includes("--release");
  console.log("Browser certification: " + (result.ready ? "ready" : "not ready"));
  for (const blocker of result.blockers) console.log("- " + blocker);
  if (release && !result.ready) process.exitCode = 1;
}
