import type { StorybookConfig } from "@storybook/web-components-vite";

const config = {
  stories: ["../src/**/*.stories.ts"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: {
    name: "@storybook/web-components-vite",
    options: {},
  },
} satisfies StorybookConfig;

export default config;
