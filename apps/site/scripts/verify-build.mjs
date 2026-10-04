import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url);

const requiredFiles = [
  "index.html",
  "onboarding/index.html",
  "favicon.svg",
];

for (const relativePath of requiredFiles) {
  await access(new URL(relativePath, dist));
}

const landing = await readFile(new URL("index.html", dist), "utf8");
const onboarding = await readFile(new URL("onboarding/index.html", dist), "utf8");

const requiredLandingFragments = [
  'href="/teldra/onboarding/"',
  'href="/teldra/favicon.svg"',
  'rel="canonical"',
];

for (const fragment of requiredLandingFragments) {
  if (!landing.includes(fragment)) {
    throw new Error(`Landing page is missing expected GitHub Pages output: ${fragment}`);
  }
}

if (!onboarding.includes('href="/teldra/"')) {
  throw new Error("Onboarding page does not link back through the /teldra/ base path.");
}

const accidentalRootRoutes = [
  'href="/onboarding/',
  'href="/favicon.svg"',
];

for (const fragment of accidentalRootRoutes) {
  if (landing.includes(fragment) || onboarding.includes(fragment)) {
    throw new Error(`Build contains an accidental root-relative route: ${fragment}`);
  }
}

console.log("Teldra site build verified: landing, onboarding, favicon, metadata, and base paths are present.");
