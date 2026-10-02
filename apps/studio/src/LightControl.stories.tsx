import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { LightControl } from "./LightControl";
import "./LightControl.css";

const meta = {
  title: "Studio/LightControl",
  component: LightControl,
  args: {
    label: "Floor lamp",
    on: true,
  },
} satisfies Meta<typeof LightControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Interactive: Story = {
  render: (args) => {
    const [on, setOn] = createSignal(args.on);

    return (
      <LightControl
        {...args}
        on={on()}
        onChange={(next) => {
          setOn(next);
          args.onChange?.(next);
        }}
      />
    );
  },
};

export const Off: Story = {
  args: {
    on: false,
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};
