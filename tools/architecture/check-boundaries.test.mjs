import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  parseImportSpecifiers,
  validateSpecifier,
} from "./check-boundaries.mjs";

function project(name, layer, dependencies = {}, exportsField = { ".": "./src/index.ts" }) {
  return {
    name,
    layer,
    dir: path.join("/repo/packages", name.split("/").at(-1)),
    manifest: {
      name,
      dependencies,
      exports: exportsField,
      nx: {
        tags: [`layer:${layer}`],
      },
    },
  };
}

const schema = project(
  "@teldra/schemas",
  "schema",
  {},
  {
    "./project": "./json/project.schema.json",
    "./twin": "./json/twin.schema.json",
  },
);
const domain = project("@teldra/domain", "domain", {
  "@teldra/schemas": "workspace:*",
});
const projection = project("@teldra/projection", "projection", {
  "@teldra/domain": "workspace:*",
});

const projectsByName = new Map(
  [schema, domain, projection].map((value) => [value.name, value]),
);

test("extracts static, side-effect, dynamic, and require imports", () => {
  const imports = parseImportSpecifiers(`
    import type { TwinProject } from "@teldra/domain";
    import "@teldra/schemas/twin";
    export { thing } from "@teldra/domain";
    const lazy = import("@teldra/projection");
    const legacy = require("legacy");
  `);

  assert.deepEqual(
    new Set(imports),
    new Set([
      "@teldra/domain",
      "@teldra/schemas/twin",
      "@teldra/projection",
      "legacy",
    ]),
  );
});

test("does not treat string literals ending in import as side-effect imports", () => {
  const imports = parseImportSpecifiers(`
    export const subsystem = "sh3d-import";
    export const another = "plain-import";
  `);

  assert.deepEqual(imports, []);
});

test("domain may depend on an explicitly exported schema subpath", () => {
  const errors = validateSpecifier({
    sourceProject: domain,
    specifier: "@teldra/schemas/twin",
    projectsByName,
    filePath: "/repo/packages/domain/src/index.ts",
    repoRoot: "/repo",
  });

  assert.deepEqual(errors, []);
});

test("domain cannot depend on projection", () => {
  const errors = validateSpecifier({
    sourceProject: domain,
    specifier: "@teldra/projection",
    projectsByName,
    filePath: "/repo/packages/domain/src/index.ts",
    repoRoot: "/repo",
  });

  assert.ok(errors.some((error) => error.includes("cannot depend")));
});

test("canonical layers cannot import UI or renderer packages", () => {
  for (const specifier of ["solid-js", "lit", "@babylonjs/core", "@deck.gl/core"]) {
    const errors = validateSpecifier({
      sourceProject: domain,
      specifier,
      projectsByName,
      filePath: "/repo/packages/domain/src/index.ts",
      repoRoot: "/repo",
    });

    assert.ok(
      errors.some((error) => error.includes("may not import framework/renderer")),
      specifier,
    );
  }
});

test("deep imports are rejected when not in package exports", () => {
  const errors = validateSpecifier({
    sourceProject: projection,
    specifier: "@teldra/domain/src/index.ts",
    projectsByName,
    filePath: "/repo/packages/projection/src/index.ts",
    repoRoot: "/repo",
  });

  assert.ok(errors.some((error) => error.includes("deep-imports non-public")));
});
