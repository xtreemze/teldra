import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/pages");
for (const path of ["index.html", "onboarding/index.html", "studio/index.html", "studio/demo.teldra", ".nojekyll"]) await access(resolve(root, path));
for (const path of ["index.html", "onboarding/index.html", "studio/index.html"]) {
  const html = await readFile(resolve(root,path),"utf8");
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    const url = match[1].split(/[?#]/)[0];
    if (/^(https?:|data:|mailto:)/.test(url)) continue;
    if (url.startsWith("/") && !url.startsWith("/teldra/")) throw new Error(`Root-relative asset outside Pages base: ${url}`);
    const relative = url.startsWith("/teldra/") ? url.slice(8) : null;
    const target = relative === null ? resolve(dirname(resolve(root,path)),url) : resolve(root,relative);
    await access(target);
  }
}
console.log("Pages routes and nested asset references verified.");

const studioDir = resolve(root, "studio");
const manifest = JSON.parse(await readFile(resolve(studioDir, "manifest.webmanifest"), "utf8"));
if (manifest.scope !== "./" || manifest.start_url !== "./" || manifest.display !== "standalone")
  throw new Error("PWA must remain scoped to the /teldra/studio/ subpath.");
for (const icon of manifest.icons) {
  if (!icon.src.startsWith("icons/")) throw new Error("Unexpected PWA icon path.");
  await access(resolve(studioDir, icon.src));
}
await access(resolve(studioDir, "favicon.svg"));
await access(resolve(studioDir, "icons/apple-touch-icon.png"));
const worker = await readFile(resolve(studioDir, "service-worker.js"), "utf8");
const match = worker.match(/^const PRECACHE = (.+);$/m);
if (!match) throw new Error("No generated service-worker precache.");
const precache = JSON.parse(match[1]);
for (const required of ["./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png"]) {
  if (!precache.includes(required)) throw new Error("Missing offline PWA asset: " + required);
}
if (precache.some(path => /\.teldra$/i.test(path)))
  throw new Error("Large project archives must not enter the mandatory PWA precache.");
for (const url of precache) {
  if (!url.startsWith("./") || url.includes("..")) throw new Error("Invalid PWA precache URL: " + url);
  await access(resolve(studioDir, url.slice(2)));
}
const buildInfo = JSON.parse(await readFile(resolve(studioDir, "build-info.json"), "utf8"));
if (buildInfo.schemaVersion !== 1 ||
    !/^[0-9a-f]{16}$/i.test(buildInfo.shellRevision) ||
    (buildInfo.sourceCommit !== null && !/^[0-9a-f]{40}$/i.test(buildInfo.sourceCommit))) {
  throw new Error("Studio build provenance must include valid commit and asset revision.");
}
if (!worker.includes(JSON.stringify("teldra-studio-shell-" + buildInfo.shellRevision))) {
  throw new Error("Published build revision must match the actual service-worker cache.");
}
if (precache.includes("./build-info.json")) {
  throw new Error("Deployed revision metadata must bypass the offline shell cache.");
}
console.log("Studio install manifest, generated icon family, build provenance and offline precache verified.");
