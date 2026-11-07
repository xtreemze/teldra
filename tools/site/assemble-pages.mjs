import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(root, "dist/pages");
if (output !== resolve(root, "dist", "pages")) throw new Error("Invalid Pages output path");
// Only the dedicated generated output tree is replaced.
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});
await cp(resolve(root, "apps/site/dist"), output, {recursive: true});
await cp(resolve(root, "apps/studio/dist"), resolve(output, "studio"), {recursive: true});
await writeFile(resolve(output, ".nojekyll"), "");
await mkdir(resolve(output, "studio/licenses"), {recursive: true});
await cp(resolve(root, "apps/studio/node_modules/web-ifc/LICENSE.md"), resolve(output, "studio/licenses/web-ifc-LICENSE.md"));
await writeFile(resolve(output,"studio/third-party-notices.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Teldra third-party notices</title><body><main><h1>Third-party notices</h1><p>Teldra uses web-ifc 0.0.78 (MPL-2.0) for local IFC reading and writing. The upstream library is distributed unmodified.</p><p><a href="licenses/web-ifc-LICENSE.md">Mozilla Public License 2.0</a> � <a href="https://github.com/ThatOpen/engine_web-ifc">Corresponding upstream source</a></p><p>Babylon.js (Apache-2.0), SolidJS (MIT) and other dependencies retain their upstream notices. See the repository dependency manifest for exact versions.</p><a href="./">Return to Studio</a></main></body></html>`);
const studio = await readFile(resolve(output, "studio/index.html"), "utf8");
if (!studio.includes("assets/")) throw new Error("Studio application assets are missing");
console.log("Assembled complete Pages tree: site, onboarding, Studio and complete 21D demo.");
