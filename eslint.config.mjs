import nx from "@nx/eslint-plugin";

const coreBannedImports = [
  "solid-js",
  "lit",
  "@babylonjs/*",
  "@deck.gl/*"
];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.nx/**"
    ]
  },
  ...nx.configs["flat/base"],
  ...nx.configs["flat/typescript"],
  ...nx.configs["flat/javascript"],
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          allow: [],
          banTransitiveDependencies: true,
          depConstraints: [
            {
              sourceTag: "layer:schema",
              onlyDependOnLibsWithTags: ["layer:schema"]
            },
            {
              sourceTag: "layer:domain",
              onlyDependOnLibsWithTags: ["layer:schema", "layer:domain"],
              bannedExternalImports: coreBannedImports
            },
            {
              sourceTag: "layer:application",
              onlyDependOnLibsWithTags: [
                "layer:schema",
                "layer:domain",
                "layer:application"
              ],
              bannedExternalImports: coreBannedImports
            },
            {
              sourceTag: "layer:projection",
              onlyDependOnLibsWithTags: [
                "layer:schema",
                "layer:domain",
                "layer:application",
                "layer:projection"
              ],
              bannedExternalImports: coreBannedImports
            },
            {
              sourceTag: "layer:runtime",
              onlyDependOnLibsWithTags: [
                "layer:schema",
                "layer:domain",
                "layer:application",
                "layer:projection",
                "layer:runtime"
              ]
            },
            {
              sourceTag: "layer:integration",
              onlyDependOnLibsWithTags: [
                "layer:schema",
                "layer:domain",
                "layer:application",
                "layer:projection",
                "layer:integration"
              ]
            },
            {
              sourceTag: "layer:app",
              onlyDependOnLibsWithTags: ["*"]
            }
          ]
        }
      ]
    }
  }
];
