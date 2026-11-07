import {createSignal} from "solid-js";
import type {Meta, StoryObj} from "storybook-solidjs-vite";
import type {FurnitureWorldPose} from "@teldra/application";
import {MobileTransformPad} from "./MobileTransformPad";

function Harness(props: {mode: "translate" | "rotate"; startExpanded?: boolean}) {
  const [pose, setPose] = createSignal<FurnitureWorldPose>({position: [1, 2, 3], yawRadians: 0});
  return <div style={{position: "relative", width: "390px", height: "700px", background: "#14202b", color: "#e7edf4"}}>
    <output data-testid="mobile-transform-pose">{JSON.stringify(pose())}</output>
    <MobileTransformPad mode={props.mode} startExpanded={props.startExpanded} pose={pose} onPreview={setPose}
      translationSnap={0.05} rotationSnap={Math.PI / 12}
      onApply={() => {}} onCancel={() => setPose({position: [1, 2, 3], yawRadians: 0})} />
  </div>;
}
const meta = {title: "Studio/MobileTransformPad", component: Harness,
  parameters: {layout: "fullscreen", viewport: {defaultViewport: "mobile1"}}} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Move: Story = {args: {mode: "translate", startExpanded: true}};
export const Rotate: Story = {args: {mode: "rotate", startExpanded: true}};
export const Collapsed: Story = {args: {mode: "translate", startExpanded: false}};
