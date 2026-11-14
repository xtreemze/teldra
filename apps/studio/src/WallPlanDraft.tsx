import { createMemo, createSignal, For, Show } from "solid-js";
import {
  constrainPlanAngle,
  straightWallFootprint,
  validateStraightWallDraft,
  type PlanPoint,
  type StraightWallDraft,
} from "@teldra/application";

const WIDTH = 640;
const HEIGHT = 400;
const PIXELS_PER_METRE = 32;
const GRID_METRES = 0.25;

/** Non-authoritative 2D CAD draft: never updates IFC or marks the project dirty. */
export function WallPlanDraft() {
  const [start, setStart] = createSignal<PlanPoint | null>(null);
  const [end, setEnd] = createSignal<PlanPoint | null>(null);
  const [pointer, setPointer] = createSignal<PlanPoint | null>(null);
  const [thickness, setThickness] = createSignal(0.15);
  const [height, setHeight] = createSignal(2.6);
  const [angleStep, setAngleStep] = createSignal(45);
  const [gridEnabled, setGridEnabled] = createSignal(true);
  const [message, setMessage] = createSignal("");

  const rawEnd = () => end() ?? pointer();
  const constrainedEnd = () => {
    const a = start();
    const b = rawEnd();
    if (!a || !b) return null;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return b;
    return angleStep() > 0 ? constrainPlanAngle(a, b, angleStep()) : b;
  };
  const draft = createMemo((): StraightWallDraft | null => {
    const a = start(), b = constrainedEnd();
    return a && b ? { start: a, end: b, thicknessMetres: thickness(), heightMetres: height() } : null;
  });
  const validDraft = createMemo(() => {
    const d = draft();
    if (!d) return null;
    try { return validateStraightWallDraft(d); } catch { return null; }
  });
  const length = () => {
    const a = start(), b = constrainedEnd();
    return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
  };
  const toScreen = (point: PlanPoint): PlanPoint => [
    WIDTH / 2 + point[0] * PIXELS_PER_METRE,
    HEIGHT / 2 - point[1] * PIXELS_PER_METRE,
  ];
  const toPlan = (clientX: number, clientY: number, rect: DOMRect): PlanPoint => {
    const x = (clientX - rect.left) * WIDTH / rect.width;
    const y = (clientY - rect.top) * HEIGHT / rect.height;
    const raw: PlanPoint = [(x - WIDTH / 2) / PIXELS_PER_METRE, (HEIGHT / 2 - y) / PIXELS_PER_METRE];
    return gridEnabled()
      ? [Math.round(raw[0] / GRID_METRES) * GRID_METRES, Math.round(raw[1] / GRID_METRES) * GRID_METRES]
      : raw;
  };
  const clickPlan = (event: MouseEvent & { currentTarget: SVGSVGElement }) => {
    const point = toPlan(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    if (!start() || end()) { setStart(point); setEnd(null); setMessage(""); }
    else { setEnd(point); setPointer(null); }
  };
  const movePlan = (event: MouseEvent & { currentTarget: SVGSVGElement }) => {
    if (start() && !end()) {
      setPointer(toPlan(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect()));
    }
  };
  const reset = () => { setStart(null); setEnd(null); setPointer(null); setMessage(""); };
  const editPoint = (endpoint: "start" | "end", axis: 0 | 1, value: number) => {
    if (endpoint === "start") {
      const p = start() ?? [0, 0];
      setStart(axis === 0 ? [value, p[1]] : [p[0], value]);
    } else {
      const p = end() ?? [1, 0];
      setEnd(axis === 0 ? [value, p[1]] : [p[0], value]);
    }
    setMessage("");
  };
  const exportIntent = () => {
    const wall = validDraft();
    if (!wall || !end()) { setMessage("Finish a valid wall segment before exporting."); return; }
    const intent = JSON.stringify({
      format: "teldra-wall-draft-v1",
      operation: "CreateWall",
      coordinateFrame: "ifc-world-metres-z-up",
      wall,
      warning: "Preview-only draft; not an IFC edit. Review and apply through an IFC authoring transaction.",
    }, null, 2);
    const url = URL.createObjectURL(new Blob([intent], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "teldra-wall-draft.json";
    document.body.append(a);
    try { a.click(); } finally { a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 5_000); }
  };
  const corners = () => {
    const wall = validDraft();
    if (!wall) return "";
    return straightWallFootprint(wall).map(p => toScreen(p).join(",")).join(" ");
  };
  const gridLines = Array.from({ length: 31 }, (_, index) => index - 15);

  return <section aria-label="Wall plan draft" class="teldra-wall-plan-draft">
    <h3>Draw wall — 2D plan</h3>
    <p>Click the start and end points, or enter exact coordinates. Units are metres. This is a reviewable CAD draft only; it cannot yet modify or save IFC walls.</p>
    <div role="group" aria-label="Wall drafting constraints">
      <label><input type="checkbox" checked={gridEnabled()} onChange={event => setGridEnabled(event.currentTarget.checked)} /> Snap to 0.25 m grid</label>
      <label>Angle constraint
        <select value={angleStep()} onChange={event => setAngleStep(Number(event.currentTarget.value))}>
          <option value="0">Off</option><option value="15">15°</option><option value="30">30°</option>
          <option value="45">45°</option><option value="90">90°</option>
        </select>
      </label>
    </div>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Interactive metre-based wall plan, click twice to draw a wall"
      style={{ width: "100%", "max-width": "640px", "background-color": "var(--surface, #1b1b1b)", "touch-action": "manipulation", cursor: "crosshair" }}
      onClick={clickPlan} onMouseMove={movePlan} onMouseLeave={() => setPointer(null)}>
      <For each={gridLines}>{v => <>
        <line x1={WIDTH / 2 + v * PIXELS_PER_METRE} y1="0" x2={WIDTH / 2 + v * PIXELS_PER_METRE} y2={HEIGHT} stroke="currentColor" stroke-opacity=".12" />
        <line x1="0" y1={HEIGHT / 2 + v * PIXELS_PER_METRE} x2={WIDTH} y2={HEIGHT / 2 + v * PIXELS_PER_METRE} stroke="currentColor" stroke-opacity=".12" />
      </>}</For>
      <line x1={WIDTH / 2} x2={WIDTH / 2} y1="0" y2={HEIGHT} stroke="currentColor" stroke-opacity=".35" />
      <line x1="0" x2={WIDTH} y1={HEIGHT / 2} y2={HEIGHT / 2} stroke="currentColor" stroke-opacity=".35" />
      <Show when={validDraft()}><polygon points={corners()} fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="2" /></Show>
      <Show when={start()}>{p => <circle cx={toScreen(p())[0]} cy={toScreen(p())[1]} r="5" fill="currentColor" />}</Show>
      <Show when={constrainedEnd()}>{p => <circle cx={toScreen(p())[0]} cy={toScreen(p())[1]} r="5" fill="currentColor" />}</Show>
    </svg>
    <fieldset>
      <legend>Wall dimensions and endpoints</legend>
      <For each={[["Start", "start"], ["End", "end"]] as const}>{([title, kind]) => <div>
        <strong>{title}</strong>
        <For each={["X", "Y"] as const}>{(axis, index) => <label>{axis} (m)
          <input aria-label={`${title} ${axis} (m)`} type="number" step="any" value={(kind === "start" ? start() : end())?.[index()] ?? 0}
            onInput={event => editPoint(kind, index() as 0 | 1, event.currentTarget.valueAsNumber)} />
        </label>}</For>
      </div>}</For>
      <label>Thickness (m) <input type="number" min=".001" max="100" step="any" value={thickness()} onInput={event => setThickness(event.currentTarget.valueAsNumber)} /></label>
      <label>Height (m) <input type="number" min=".001" max="100" step="any" value={height()} onInput={event => setHeight(event.currentTarget.valueAsNumber)} /></label>
      <output aria-live="polite">Length: {length().toFixed(3)} m</output>
    </fieldset>
    <div role="group" aria-label="Wall draft actions">
      <button type="button" onClick={reset}>Clear draft</button>
      <button type="button" disabled={!validDraft() || !end()} onClick={exportIntent}>Export wall draft JSON</button>
      <button type="button" disabled title="Awaiting IFC-authoritative Studio wall transactions">Apply to IFC (not yet supported)</button>
    </div>
    <Show when={message()}><p role="alert">{message()}</p></Show>
  </section>;
}
