import { createSignal, onCleanup, onMount } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createBabylonTwinRuntime, type BabylonTwinRuntime, type FurnitureEditSession } from "@teldra/runtime-babylon";

const manifest = {
  schemaVersion: "0.1.0", coordinateSystem: { unit: "metre", handedness: "right", upAxis: "Z" },
  source: { buildingPath: "fixture.ifc", buildingSha256: "a".repeat(64) },
  scene: { assetPath: "/fixtures/twin-pick.glb", assetSha256: "b".repeat(64), format: "glb",
    canonicalToScene: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] },
  nodes: [{nodeKey: "ifc:fixture-wall:body", canonicalId: "wall:fixture", ifcGlobalId: "1234567890123456789012", kind: "building", renderPart: "body"}],
};
const origin = {position: [0, 0, 0] as const, yawRadians: 0};

function GizmoHarness() {
  let canvas!: HTMLCanvasElement;
  let runtime: BabylonTwinRuntime | undefined;
  let session: FurnitureEditSession | undefined;
  const [pose, setPose] = createSignal(JSON.stringify(origin));
  const [scale, setScale] = createSignal("1,1,1");
  const [status, setStatus] = createSignal("loading");
  const [drag, setDrag] = createSignal("idle");
  const [point, setPoint] = createSignal("pending");
  onMount(() => { void (async () => {
    try {
      runtime = await createBabylonTwinRuntime(canvas, manifest);
      await runtime.load("/fixtures/twin-pick.glb");
      runtime.start();
      const p = runtime.projectNode("ifc:fixture-wall:body");
      setPoint(JSON.stringify(p));
      session = runtime.beginFurnitureEdit({
        canonicalId: "wall:fixture", original: origin, current: origin,
        sourceScale: [1,1,1], currentScale: [1,1,1],
      }, value => {
        setPose(JSON.stringify(value)); setPoint(JSON.stringify(runtime?.projectNode("ifc:fixture-wall:body")));
      }, value => setDrag(value ? "dragging" : "ended"), value => {
        setScale(value.join(",")); setPoint(JSON.stringify(runtime?.projectNode("ifc:fixture-wall:body")));
      });
      setStatus("ready");
    } catch (error) { setStatus(`error: ${String(error)}`); }
  })(); });
  onCleanup(() => { session?.cancel(); runtime?.dispose(); });
  return <div style={{width:"640px", "overflow-wrap":"anywhere"}}><canvas data-testid="gizmo-canvas" ref={canvas} width="640" height="400" style={{width: "640px", height: "400px"}} />
    <button onClick={() => session?.setMode("translate")}>Translate</button>
    <button onClick={() => session?.setMode("rotate")}>Rotate</button>
    <button onClick={() => session?.setMode("scale")}>Scale</button>
    <button onClick={() => { session?.setScale([1.5,1,0.75]); setScale("1.5,1,0.75"); setPoint(JSON.stringify(runtime?.projectNode("ifc:fixture-wall:body"))); }}>Set scale XYZ</button>
    <button onClick={() => { session?.cancel(); setPoint(JSON.stringify(runtime?.projectNode("ifc:fixture-wall:body"))); }}>Cancel</button>
    <output data-testid="gizmo-status">{status()}</output><output data-testid="gizmo-pose">{pose()}</output>
    <output data-testid="gizmo-scale">{scale()}</output>
    <output data-testid="gizmo-drag">{drag()}</output><output data-testid="gizmo-pickpoint">{point()}</output></div>;
}
const meta = {title: "Studio/FurnitureGizmoDiagnostic", component: GizmoHarness, parameters: {layout: "fullscreen"}} satisfies Meta<typeof GizmoHarness>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TranslationAndRotation: Story = {};
