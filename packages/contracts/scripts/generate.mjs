import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const generated = resolve(here, "../src/generated");

await mkdir(generated, { recursive: true });

const inputs = [
  ["twin", resolve(root, "schemas/json/twin.schema.json")],
  ["project", resolve(root, "schemas/json/project.schema.json")]
];

for (const [name, input] of inputs) {
  const source = await compileFromFile(input, {
    bannerComment: [
      "/* eslint-disable */",
      "/**",
      " * Generated from Teldra JSON Schema.",
      " * Do not edit by hand; update schemas/json and run pnpm --filter @teldra/contracts generate.",
      " */"
    ].join("\n"),
    enableConstEnums: false,
    format: true
  });

  await writeFile(resolve(generated, `${name}.ts`), source, "utf8");
}

const twin = JSON.parse(await readFile(inputs[0][1], "utf8"));
const project = JSON.parse(await readFile(inputs[1][1], "utf8"));
const schemasSource = [
  "/* eslint-disable */",
  "/** Generated from schemas/json. Do not edit by hand. */",
  `export const twinSchema = ${JSON.stringify(twin, null, 2)} as const;`,
  `export const projectSchema = ${JSON.stringify(project, null, 2)} as const;`,
  ""
].join("\n");

await writeFile(resolve(generated, "schemas.ts"), schemasSource, "utf8");
