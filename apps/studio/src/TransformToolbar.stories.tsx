import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { TransformToolbar, type TransformToolbarProps } from "./TransformToolbar";
import "./StudioSelectionWorkspace.css";
import "./TransformToolbar.css";

function Harness(props: TransformToolbarProps) {
  return <main class="teldra-studio-selection-workspace" style={{ background: "#17212d", padding: "1rem" }}><TransformToolbar {...props} /></main>;
}
const meta = {
  title: "Studio/TransformToolbar",
  component: Harness,
  args: { selectionLabel: "Chair", onSelectMode: () => {} },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};
export const MoveActive: Story = { args: { activeMode: "translate" } };
export const RotateActive: Story = { args: { activeMode: "rotate" } };
export const ScaleUnsupported: Story = {
  args: { activeMode: "translate", scale: { supported: false, reason: "This IFC representation cannot be scaled safely." } },
};
export const SceneLoading: Story = { args: { ready: false } };
export const UnsupportedWall: Story = {
  args: {
    selectionLabel: "Wall",
    unavailable: {
      reason: "Wall, floor and opening creation or modification is not yet supported; no mesh-only changes will be saved.",
      workaround: "Use Wall draft (2D) to export a draft, or edit the IFC in Bonsai and reopen it.",
    },
  },
};
export const WithLifecycleActions: Story = { args: { onDuplicate: () => {}, onDelete: () => {} } };
export const LifecycleActionsBlocked: Story = {
  args: {
    selectionLabel: "Wall", onDuplicate: () => {}, onDelete: () => {},
    unavailable: { reason: "Walls cannot be duplicated or deleted yet.", workaround: "Edit the IFC in Bonsai and reopen the project." },
  },
};
