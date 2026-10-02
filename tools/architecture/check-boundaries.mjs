import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const ALLOWED_LAYERS = Object.freeze({
  schema: new Set(["schema"]),
  domain: new Set(["schema", "domain"]),
  application: new Set(["schema", "domain", "application"]),
  projection: new Set(["schema", "domain", "application", "projection"]),
  runtime: new Set(["schema", "domain", "application", "projection", "runtime"]),
  integration: new Set([
    "schema",
    "domain",
    "application",
    "projection",
    "integration",
  ]),
  app: new Set([
    "schema",
    "domain",
    "application",
    "projection",
    "runtime",
    "integration",
    "app",
  ]),
});

const CORE_BANNED_EXTERNALS = Object.freeze([
  "solid-js",
  "lit",
  "@babylonjs/*",
  "@deck.gl/*",
]);

const CORE_LAYERS = new Set(["domain", "application", "projection"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"]);

export function parseImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^;"']*?\sfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        specifiers.add(match[1]);
      }
    }
  }

  return [...specifiers];
}

export function validateSpecifier({
  sourceProject,
  specifier,
  projectsByName,
  filePath,
  repoRoot = REPO_ROOT,
}) {
  const errors = [];

  if (specifier.startsWith("node:")) {
    return errors;
  }

  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(filePath), specifier);
    const sourceRoot = path.resolve(sourceProject.dir);
    const fixturesRoot = path.join(repoRoot, "fixtures");

    if (!isInside(resolved, sourceRoot) && !isInside(resolved, fixturesRoot)) {
      errors.push(
        `${relative(repoRoot, filePath)} crosses its project boundary with relative import "${specifier}".`,
      );
    }

    return errors;
  }

  const targetProject = findInternalProject(specifier, projectsByName);

  if (targetProject) {
    const allowed = ALLOWED_LAYERS[sourceProject.layer];

    if (!allowed?.has(targetProject.layer)) {
      errors.push(
        `${relative(repoRoot, filePath)} (${sourceProject.layer}) cannot depend on ${targetProject.name} (${targetProject.layer}).`,
      );
    }

    const subpath = specifier.slice(targetProject.name.length);

    if (!isExportedSubpath(targetProject.manifest.exports, subpath)) {
      errors.push(
        `${relative(repoRoot, filePath)} deep-imports non-public path "${specifier}".`,
      );
    }

    if (!declaredDependencies(sourceProject.manifest).has(targetProject.name)) {
      errors.push(
        `${relative(repoRoot, filePath)} imports "${targetProject.name}" without declaring it in package.json.`,
      );
    }

    return errors;
  }

  if (specifier.startsWith("@teldra/")) {
    errors.push(
      `${relative(repoRoot, filePath)} imports unknown internal package "${specifier}".`,
    );
    return errors;
  }

  if (
    CORE_LAYERS.has(sourceProject.layer) &&
    CORE_BANNED_EXTERNALS.some((pattern) => matchesPackagePattern(specifier, pattern))
  ) {
    errors.push(
      `${relative(repoRoot, filePath)} (${sourceProject.layer}) may not import framework/renderer package "${specifier}".`,
    );
  }

  if (isSourceFile(filePath, sourceProject.dir)) {
    const packageName = externalPackageName(specifier);

    if (
      packageName &&
      !declaredDependencies(sourceProject.manifest).has(packageName)
    ) {
      errors.push(
        `${relative(repoRoot, filePath)} imports transitive dependency "${packageName}" without declaring it in package.json.`,
      );
    }
  }

  return errors;
}

export async function checkRepository(repoRoot = REPO_ROOT) {
  const projects = await discoverProjects(repoRoot);
  const projectsByName = new Map(projects.map((project) => [project.name, project]));
  const errors = [];

  for (const project of projects) {
    const allowed = ALLOWED_LAYERS[project.layer];

    if (!allowed) {
      errors.push(`${project.name} has unsupported Nx layer tag "layer:${project.layer}".`);
      continue;
    }

    for (const dependency of declaredDependencies(project.manifest)) {
      const target = projectsByName.get(dependency);

      if (target && !allowed.has(target.layer)) {
        errors.push(
          `${project.name} (${project.layer}) declares disallowed dependency ${target.name} (${target.layer}).`,
        );
      }
    }

    for (const filePath of await listSourceFiles(project.dir)) {
      const source = await readFile(filePath, "utf8");

      for (const specifier of parseImportSpecifiers(source)) {
        errors.push(
          ...validateSpecifier({
            sourceProject: project,
            specifier,
            projectsByName,
            filePath,
            repoRoot,
          }),
        );
      }
    }
  }

  return errors;
}

async function discoverProjects(repoRoot) {
  const packageDirs = [];

  for (const parent of ["packages", "apps"]) {
    const parentDir = path.join(repoRoot, parent);

    let entries = [];
    try {
      entries = await readdir(parentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        packageDirs.push(path.join(parentDir, entry.name));
      }
    }
  }

  packageDirs.push(path.join(repoRoot, "schemas"));

  const projects = [];

  for (const dir of packageDirs) {
    let manifest;

    try {
      manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }

    if (typeof manifest.name !== "string") {
      continue;
    }

    const layerTag = manifest.nx?.tags?.find(
      (tag) => typeof tag === "string" && tag.startsWith("layer:"),
    );

    if (!layerTag) {
      if (manifest.name.startsWith("@teldra/")) {
        throw new Error(`${manifest.name} must declare an Nx layer:* tag.`);
      }
      continue;
    }

    projects.push({
      name: manifest.name,
      layer: layerTag.slice("layer:".length),
      dir,
      manifest,
    });
  }

  return projects;
}

async function listSourceFiles(dir) {
  const files = [];

  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
        continue;
      }

      const candidate = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await visit(candidate);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(candidate);
      }
    }
  }

  await visit(dir);
  return files;
}

function findInternalProject(specifier, projectsByName) {
  return [...projectsByName.values()]
    .sort((left, right) => right.name.length - left.name.length)
    .find(
      (project) =>
        specifier === project.name || specifier.startsWith(`${project.name}/`),
    );
}

function isExportedSubpath(exportsField, suffix) {
  const key = suffix ? `.${suffix}` : ".";

  if (typeof exportsField === "string") {
    return key === ".";
  }

  if (!exportsField || typeof exportsField !== "object") {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(exportsField, key);
}

function declaredDependencies(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
}

function externalPackageName(specifier) {
  if (specifier.startsWith("#") || specifier.startsWith("/") || specifier.includes(":")) {
    return null;
  }

  const parts = specifier.split("/");

  if (specifier.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }

  return parts[0] || null;
}

function matchesPackagePattern(specifier, pattern) {
  if (pattern.endsWith("/*")) {
    return specifier.startsWith(pattern.slice(0, -1));
  }

  return specifier === pattern || specifier.startsWith(`${pattern}/`);
}

function isSourceFile(filePath, projectDir) {
  return isInside(filePath, path.join(projectDir, "src"));
}

function isInside(candidate, parent) {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function relative(root, value) {
  return path.relative(root, value).split(path.sep).join("/");
}

async function main() {
  const errors = await checkRepository();

  if (errors.length > 0) {
    console.error("Teldra architecture boundary violations:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Teldra architecture boundaries are valid.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
