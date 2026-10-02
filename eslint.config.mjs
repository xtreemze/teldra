import nx from "@nx/eslint-plugin";

export default [
  ...nx.configs["flat/base"],
  ...nx.configs["flat/typescript"],
  ...nx.configs["flat/javascript"],
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs"],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          allow: [],
          banTransitiveDependencies: true,
          depConstraints: [
            {
              sourceTag: "layer:contracts",
              onlyDependOnLibsWithTags: ["layer:contracts"]
            },
            {
              sourceTag: "layer:domain",
              onlyDependOnLibsWithTags: ["layer:contracts", "layer:domain"]
            },
            {
              sourceTag: "layer:application",
              onlyDependOnLibsWithTags: ["layer:contracts", "layer:domain", "layer:application"]
            },
            {
              sourceTag: "layer:projection",
              onlyDependOnLibsWithTags: ["layer:contracts", "layer:domain", "layer:application", "layer:projection"]
            },
            {
              sourceTag: "layer:runtime",
              onlyDependOnLibsWithTags: ["layer:contracts", "layer:domain", "layer:application", "layer:projection", "layer:runtime"]
            },
            {
              sourceTag: "layer:app",
              onlyDependOnLibsWithTags: ["*"]
            }
          ]
        }
      ]
    }
  },
  {
    files: [
      "packages/domain/**/*.{ts,tsx,js,jsx}",
      "packages/application/**/*.{ts,tsx,js,jsx}",
      "packages/projection/**/*.{ts,tsx,js,jsx}"
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "solid-js",
            "solid-js/*",
            "lit",
            "lit/*",
            "@babylonjs/*",
            "@deck.gl/*"
          ]
        }
      ]
    }
  }
];
