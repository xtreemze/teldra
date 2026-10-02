import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");

const bannerComment = `/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: canonical Teldra JSON Schema.
 * Run: pnpm schema:generate
 */`;

const targets = [
  {
    source: "schemas/json/twin.schema.json",
    target: "schemas/generated/twin.ts",
    name: "SerializedTwin",
  },
  {
    source: "schemas/json/project.schema.json",
    target: "schemas/generated/project.ts",
    name: "SerializedProjectManifest",
  },
  {
    source: "schemas/json/scene.schema.json",
    target: "schemas/generated/scene.ts",
    name: "SerializedSceneManifest",
  },
  {
    source: "schemas/json/appearance.schema.json",
    target: "schemas/generated/appearance.ts",
    name: "SerializedAppearanceManifest",
  },
  {
    source: "schemas/json/lighting.schema.json",
    target: "schemas/generated/lighting.ts",
    name: "SerializedLightingManifest",
  },
  {
    source: "schemas/json/live.schema.json",
    target: "schemas/generated/live.ts",
    name: "SerializedLiveEnvelope",
  },
];

let failed = false;

for (const target of targets) {
  const sourcePath = resolve(root, target.source);
  const targetPath = resolve(root, target.target);
  const schema = JSON.parse(await readFile(sourcePath, "utf8"));

  const generated = await compile(schema, target.name, {
    bannerComment,
    cwd: dirname(sourcePath),
    unreachableDefinitions: false,
    style: {
      bracketSpacing: true,
      printWidth: 100,
      semi: true,
      singleQuote: false,
      tabWidth: 2,
      trailingComma: "all",
      useTabs: false,
    },
  });

  if (!check) {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, generated, "utf8");
    continue;
  }

  let current = null;
  try {
    current = await readFile(targetPath, "utf8");
  } catch {
    // Missing generated output is drift.
  }

  if (current !== generated) {
    failed = true;
    console.error(`Generated schema types are stale: ${target.target}`);
    console.error(`Run "pnpm schema:generate" and commit the result.\n`);
    console.error("--- expected generated content ---");
    console.error(generated);
  }
}

if (failed) {
  process.exitCode = 1;
}
