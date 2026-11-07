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
