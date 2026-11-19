import { createResource, createSignal, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { IfcAPI } from "web-ifc";
import wasmUrl from "web-ifc/web-ifc.wasm?url";
import { IfcWallEditor } from "@teldra/application";
import { createIfcWallAdapter, readPlanSource } from "@teldra/ifc-edit";
import connectedWalls from "../../../fixtures/ifc/connected-walls/building.ifc?raw";
import goldenHome from "../../../fixtures/projects/golden-home/building.ifc?raw";
import { PlanView } from "./PlanView";
import type { PlanEditingHost } from "./PlanEditingHost";

const fixtures = { "connected-walls": connectedWalls, "golden-home": goldenHome } as const;
const WALL_B = "0TeldraWallBBBBBBBBBB1";
let apiPromise: Promise<IfcAPI> | undefined;
const loadApi = () => apiPromise ??= (async () => { const api = new IfcAPI(); await api.Init(() => wasmUrl, true); return api; })();

/**
 * Harness wiring PlanView to a REAL IfcWallEditor over an IFC fixture, the way Studio will. The read-outs are
 * canonical facts (read from editor bytes), independent of what the plan view draws.
 */
function PlanHarness(props: { fixture: keyof typeof fixtures }) {
  const [state] = createResource(async () => {
    const api = await loadApi();
    const editor = new IfcWallEditor(new TextEncoder().encode(fixtures[props.fixture]), createIfcWallAdapter(api));
    return { api, editor };
  });
  return <Show when={state()} fallback={<p>Loading IFC…</p>}>{(ready) => <Ready api={ready().api} editor={ready().editor} fixture={props.fixture} />}</Show>;
}
function Ready(props: { api: IfcAPI; editor: IfcWallEditor; fixture: keyof typeof fixtures }) {
  const [commits, setCommits] = createSignal(0);
  const [selection, setSelection] = createSignal<string | null>(null);
  const host: PlanEditingHost = {
    wallEditor: props.editor,
    readPlanSource: (bytes) => readPlanSource(props.api, bytes),
    selection: { get: selection, set: setSelection },
    onCommitted: () => setCommits((n) => n + 1),
  };
  const canonicalB = () => { commits(); return props.fixture === "connected-walls" ? props.editor.read(WALL_B).start.map((v) => Math.round(v * 1000) / 1000).join(",") : "n/a"; };
  return <div style={{ width: "680px", padding: "1rem", background: "#19242b", color: "#f2f6f9" }}>
    <output data-testid="commit-count">{commits()}</output>
    <output data-testid="selected-wall">{selection() ?? "none"}</output>
    <output data-testid="canonical-b-start">{canonicalB()}</output>
    <PlanView host={host} revision={commits} />
  </div>;
}

const meta = {
  title: "Studio/PlanView",
  component: PlanHarness,
  args: { fixture: "connected-walls" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PlanHarness>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Four IFC walls; A and B are joined, D hosts an opening. Drag A's end point and B follows. */
export const ConnectedWalls: Story = {};
/** Imported SH3D BIM: space footprint, a hosted door opening outline, and a locked (hosted) wall. */
export const GoldenHome: Story = { args: { fixture: "golden-home" } };
