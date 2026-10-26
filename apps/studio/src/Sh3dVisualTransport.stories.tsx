import { createSignal, onCleanup } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import fixture from "../../../fixtures/sh3d/visual-transport/fixture.json";
import { TwinViewport, type TwinViewportHandle } from "./TwinViewport";

function SourceAppearanceHarness() {
  const bytes = Uint8Array.from(atob(fixture.glbBase64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], {type: "model/gltf-binary"}));
  onCleanup(() => URL.revokeObjectURL(url));
  let handle: TwinViewportHandle | undefined;
  const [summary, setSummary] = createSignal("");
  const inspect = () => setSummary(JSON.stringify(handle?.assetSummary()));
  return <>
    <TwinViewport manifest={fixture.manifest} glbUrl={url} onReady={ready => {
      handle = ready;
      inspect();
    }} />
    <button type="button" onClick={inspect}>Inspect source assets</button>
    <output data-testid="source-asset-summary">{summary()}</output>
  </>;
}

const meta = {title: "Studio/SH3D visual transport", parameters: {layout: "centered"}} satisfies Meta;
export default meta;
type Story = StoryObj;
export const TexturedFurnitureAndHiddenContent: Story = {render: () => <SourceAppearanceHarness />};
