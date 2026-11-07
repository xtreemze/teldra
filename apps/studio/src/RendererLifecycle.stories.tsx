import { createSignal, onCleanup, onMount } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createBabylonTwinRuntime, type BabylonTwinRuntime } from "@teldra/runtime-babylon";

const manifest = {
  schemaVersion: "0.1.0",
  coordinateSystem: { unit: "metre", handedness: "right", upAxis: "Z" },
  source: { buildingPath: "fixture.ifc", buildingSha256: "a".repeat(64) },
  scene: { assetPath: "/fixtures/twin-pick.glb", assetSha256: "b".repeat(64), format: "glb",
    canonicalToScene: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] },
  nodes: [{ nodeKey: "ifc:missing:body", canonicalId: "wall:missing",
    ifcGlobalId: "1234567890123456789012", kind: "building", renderPart: "body" }],
};

function LifecycleHarness() {
  let canvas!: HTMLCanvasElement;
  const runtimes: BabylonTwinRuntime[] = [];
  const [result, setResult] = createSignal("pending");
  onMount(() => { void (async () => {
    try {
      const runtime = await createBabylonTwinRuntime(canvas, manifest);
      runtimes.push(runtime);
      const first = runtime.load("/fixtures/twin-pick.glb");
      const overlap = await runtime.load("/fixtures/twin-pick.glb").then(() => "accepted", () => "rejected");
      const failed = await first.then(() => "accepted", () => "rejected");
      const repeated = await runtime.load("/fixtures/twin-pick.glb").then(() => "accepted", () => "rejected");
      const summary = runtime.assetSummary();
      const layers = runtime.layers();
      runtime.dispose();
      const second = await createBabylonTwinRuntime(canvas, manifest);
      runtimes.push(second);
      const pending = second.load("/fixtures/twin-pick.glb");
      second.dispose();
      const disposed = await pending.then(() => "accepted", () => "rejected");
      setResult(JSON.stringify({overlap, failed, repeated, meshParts: summary.meshParts,
        layers: layers.length, disposed}));
    } catch (error) { setResult(`error: ${String(error)}`); }
  })(); });
  onCleanup(() => { for (const runtime of runtimes) runtime.dispose(); });
  return <><canvas ref={canvas} width="320" height="200" /><output data-testid="lifecycle-result">{result()}</output></>;
}

const meta = { title: "Studio/RendererLifecycle", component: LifecycleHarness } satisfies Meta<typeof LifecycleHarness>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FailureAndDisposal: Story = {};
