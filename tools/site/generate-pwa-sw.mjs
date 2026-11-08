import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = resolve(root, "apps/studio/dist");
const assets = resolve(dist, "assets");
async function walk(dir) {
  const paths = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}
const staticFiles = [
  "index.html", "manifest.webmanifest", "favicon.svg",
  "icons/icon.svg", "icons/icon-maskable.svg",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];
const generated = (await walk(assets))
  .filter(path => /\.(?:js|css|wasm|svg|png|webp|jpe?g|woff2?)$/i.test(path))
  .map(path => relative(dist,path).replaceAll("\\", "/"));
const files = [...new Set([...staticFiles, ...generated])].sort();
const digest = createHash("sha256");
for (const file of files) {
  if (file.includes("..") || file.startsWith("/")) throw new Error("Unsafe precache path: " + file);
  const fullPath = resolve(dist, file);
  if (!(await stat(fullPath)).isFile()) throw new Error("PWA asset is not a file: " + file);
  digest.update(file); digest.update(await readFile(fullPath));
}
const template = await readFile(resolve(root, "tools/site/studio-sw.template.js"), "utf8");
digest.update(template);
const version = digest.digest("hex").slice(0,16);
const source = [
  "// Generated PWA worker. Do not edit dist output.",
  "const APP_CACHE = " + JSON.stringify("teldra-studio-shell-" + version) + ";",
  "const PRECACHE = " + JSON.stringify(files.map(path => "./" + path)) + ";",
  template,
].join("\n");
await writeFile(resolve(dist,"service-worker.js"), source);
// This deliberately remains outside the shell precache. A controlled old
// Studio can fetch the *deployed* revision with cache:no-store without ever
// executing, mixing or silently replacing that deployed JavaScript.
const sourceCommit = process.env.VITE_TELDRA_COMMIT || null;
if (sourceCommit !== null && !/^[0-9a-f]{40}$/i.test(sourceCommit)) {
  throw new Error("VITE_TELDRA_COMMIT must be a complete Git commit SHA.");
}
await writeFile(resolve(dist, "build-info.json"), JSON.stringify({
  schemaVersion: 1,
  sourceCommit: sourceCommit?.toLowerCase() ?? null,
  shellRevision: version,
}, null, 2) + "\n");
console.log("Generated Studio PWA worker: " + files.length + " offline shell assets, revision " + version);
