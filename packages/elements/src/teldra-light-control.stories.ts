import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { html } from "lit";
import "./teldra-light-control.js";

interface LightControlArgs {
  label: string;
  on: boolean;
  disabled: boolean;
}

const meta = {
  title: "Elements/LightControl",
  render: (args: LightControlArgs) => html`
    <teldra-light-control
      label=${args.label}
      ?on=${args.on}
      ?disabled=${args.disabled}
    ></teldra-light-control>
  `,
  args: {
    label: "Floor lamp",
    on: true,
    disabled: false,
  },
} satisfies Meta<LightControlArgs>;

export default meta;
type Story = StoryObj<LightControlArgs>;

export const Interactive: Story = {};
export const Off: Story = {
  args: { on: false },
};
export const Disabled: Story = {
  args: { disabled: true },
};
