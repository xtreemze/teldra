import type { StorybookConfig } from "storybook-solidjs-vite";

const config = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  staticDirs: ["../public"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: {
    name: "storybook-solidjs-vite",
    options: {
      docgen: false,
    },
  },
  features: {
    experimentalCodeExamples: false,
  },
} satisfies StorybookConfig;

export default config;
