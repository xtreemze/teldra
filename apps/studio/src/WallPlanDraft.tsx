import { createMemo, createSignal, For, Show } from "solid-js";
import {
  constrainPlanAngle,
  straightWallFootprint,
  validateStraightWallDraft,
  stageWallProposal,
  acceptWallProposal,
  type StagedWallProposal,
  serializeWallDraftIntent,
  serializeExistingWallEditIntent,
  wallFromReferenceBaseline,
  wallReferenceFromCentreline,
  type WallReferenceBaseline,
  type PlanPoint,
  type StraightWallDraft,
} from "@teldra/application";

const WIDTH = 640;
const HEIGHT = 400;
const PIXELS_PER_METRE = 32;
const GRID_METRES = 0.25;

/** Non-authoritative 2D CAD draft: never updates IFC or marks the project dirty. */
export function WallPlanDraft(props: { currentRevision: () => number; selectedWallGlobalId?: () => string | null }) {
  const [start, setStart] = createSignal<PlanPoint | null>(null);
  const [end, setEnd] = createSignal<PlanPoint | null>(null);
  const [pointer, setPointer] = createSignal<PlanPoint | null>(null);
  const [thickness, setThickness] = createSignal(0.15);
  const [height, setHeight] = createSignal(2.6);
  const [angleStep, setAngleStep] = createSignal(45);
  const [gridEnabled, setGridEnabled] = createSignal(true);
  const [baseline, setBaseline] = createSignal<WallReferenceBaseline>("centreline");
  const [message, setMessage] = createSignal("");
  const [proposalInput, setProposalInput] = createSignal("");
  const [pendingProposal, setPendingProposal] = createSignal<StagedWallProposal | null>(null);
  const [proposalMessage, setProposalMessage] = createSignal("");
  const previewProposal = () => {
    try {
      const parsed = stageWallProposal(proposalInput(), props.currentRevision());
      setPendingProposal(parsed);
      setProposalMessage("");
    } catch (error) {
      setPendingProposal(null);
      setProposalMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const rejectProposal = () => {
    setPendingProposal(null);
    setProposalInput("");
    setProposalMessage("Proposal rejected; existing wall draft unchanged.");
  };
  const acceptProposal = () => {
    const proposal = pendingProposal();
    if (!proposal) return;
    try {
      // Read live revision from the controller; no cached Solid signal here.
      const wall = acceptWallProposal(proposal, props.currentRevision());
      // Turn off snapping so acceptance preserves the exact reviewed geometry.
      setAngleStep(0);
      setBaseline("centreline");
      setStart([wall.start[0], wall.start[1]]);
      setEnd([wall.end[0], wall.end[1]]);
      setPointer(null);
      setThickness(wall.thicknessMetres);
      setHeight(wall.heightMetres);
      setPendingProposal(null);
      setProposalInput("");
      setProposalMessage("Proposal accepted into the local wall draft. IFC remains unchanged.");
      setMessage("");
    } catch (error) {
      // A rejected stale review never alters the already staged local draft.
      setPendingProposal(null);
      setProposalMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const rawEnd = () => end() ?? pointer();
  const constrainedEnd = () => {
    const a = start();
    const b = rawEnd();
    if (!a || !b) return null;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return b;
    return angleStep() > 0 ? constrainPlanAngle(a, b, angleStep()) : b;
  };
  const validDraft = createMemo((): StraightWallDraft | null => {
    const a = start(), b = constrainedEnd();
    if (!a || !b) return null;
    try {
      return validateStraightWallDraft(
        wallFromReferenceBaseline(a, b, thickness(), height(), baseline()),
      );
    } catch { return null; }
  });
  const chooseBaseline = (next: WallReferenceBaseline) => {
    const existing = end() ? validDraft() : null;
    if (existing) {
      // Switching references must not translate IFC-bound centreline geometry.
      const [referenceStart, referenceEnd] = wallReferenceFromCentreline(existing, next);
      setAngleStep(0);
      setStart(referenceStart);
      setEnd(referenceEnd);
    }
    setBaseline(next);
    setMessage("");
  };
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
  type Endpoint = "start" | "end";
  interface EndpointDrag {
    readonly pointerId: number;
    readonly endpoint: Endpoint;
    readonly originalStart: PlanPoint;
    readonly originalEnd: PlanPoint;
    readonly originalAngleStep: number;
  }
  interface WallTranslation {
    readonly pointerId: number;
    readonly pointerOrigin: PlanPoint;
    readonly originalStart: PlanPoint;
    readonly originalEnd: PlanPoint;
    readonly originalAngleStep: number;
  }
  let endpointDrag: EndpointDrag | null = null;
  let wallTranslation: WallTranslation | null = null;
  let ignoreCanvasClick = false;
  const translatedPoint = (point: PlanPoint, dx: number, dy: number): PlanPoint => [
    Math.round((point[0] + dx) * 1e9) / 1e9,
    Math.round((point[1] + dy) * 1e9) / 1e9,
  ];
  const translateDraft = (originalStart: PlanPoint, originalEnd: PlanPoint, dx: number, dy: number) => {
    setStart(translatedPoint(originalStart, dx, dy));
    setEnd(translatedPoint(originalEnd, dx, dy));
  };
  const beginWallTranslation = (event: PointerEvent & { currentTarget: SVGLineElement }) => {
    if (endpointDrag || wallTranslation || !start() || !end() || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const finalEnd = constrainedEnd();
    if (!finalEnd) return;
    wallTranslation = {
      pointerId: event.pointerId,
      pointerOrigin: toPlan(event.clientX, event.clientY, svg.getBoundingClientRect()),
      originalStart: [...start()!] as PlanPoint,
      originalEnd: [...end()!] as PlanPoint,
      originalAngleStep: angleStep(),
    };
    setEnd([finalEnd[0], finalEnd[1]]);
    setAngleStep(0);
    svg.setPointerCapture(event.pointerId);
    svg.focus();
    setMessage("Moving wall draft. Escape cancels; release confirms the local position.");
  };
  const moveWallTranslation = (event: PointerEvent & { currentTarget: SVGSVGElement }) => {
    const drag = wallTranslation;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const point = toPlan(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    translateDraft(
      drag.originalStart,
      drag.originalEnd,
      point[0] - drag.pointerOrigin[0],
      point[1] - drag.pointerOrigin[1],
    );
  };
  const finishWallTranslation = (
    event: PointerEvent & { currentTarget: SVGSVGElement },
    cancel: boolean,
  ) => {
    const drag = wallTranslation;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (cancel) {
      setStart(drag.originalStart);
      setEnd(drag.originalEnd);
      setAngleStep(drag.originalAngleStep);
      setMessage("Wall translation cancelled. The draft is unchanged.");
    } else {
      moveWallTranslation(event);
      setMessage("Wall translated in local draft; IFC and project history remain unchanged.");
    }
    wallTranslation = null;
    if (event.currentTarget.hasPointerCapture(drag.pointerId))
      event.currentTarget.releasePointerCapture(drag.pointerId);
    ignoreCanvasClick = true;
    window.setTimeout(() => { ignoreCanvasClick = false; }, 0);
  };
  const nudgeWall = (event: KeyboardEvent & { currentTarget: SVGLineElement }) => {
    const distance = gridEnabled() ? GRID_METRES : 0.05;
    const change: Record<string, PlanPoint> = {
      ArrowUp: [0, distance],
      ArrowDown: [0, -distance],
      ArrowLeft: [-distance, 0],
      ArrowRight: [distance, 0],
    };
    const delta = change[event.key];
    const a = start(), b = constrainedEnd();
    if (!delta || !a || !b) return;
    event.preventDefault();
    event.stopPropagation();
    setAngleStep(0);
    translateDraft(a, b, delta[0], delta[1]);
    setMessage("Wall translated by keyboard; IFC remains unchanged.");
  };

  const beginHandleDrag = (
    endpoint: Endpoint,
    event: PointerEvent & { currentTarget: SVGCircleElement },
  ) => {
    if (endpointDrag || wallTranslation || !start() || !end() || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    endpointDrag = {
      pointerId: event.pointerId,
      endpoint,
      originalStart: [...start()!] as PlanPoint,
      originalEnd: [...end()!] as PlanPoint,
      originalAngleStep: angleStep(),
    };
    // Freeze the displayed (possibly angle-constrained) end at drag start,
    // then move only the chosen endpoint. No hidden alteration of the other handle.
    setEnd([constrainedEnd()![0], constrainedEnd()![1]]);
    setAngleStep(0);
    svg.setPointerCapture(event.pointerId);
    setMessage("Dragging wall " + endpoint + " handle. Escape cancels; release confirms the local draft.");
    svg.focus();
  };
  const moveHandleDrag = (event: PointerEvent & { currentTarget: SVGSVGElement }) => {
    if (!endpointDrag || event.pointerId !== endpointDrag.pointerId) return;
    const point = toPlan(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    if (endpointDrag.endpoint === "start") setStart(point);
    else setEnd(point);
  };
  const finishHandleDrag = (
    event: PointerEvent & { currentTarget: SVGSVGElement },
    cancel: boolean,
  ) => {
    const current = endpointDrag;
    if (!current || event.pointerId !== current.pointerId) return;
    if (cancel) {
      setStart(current.originalStart);
      setEnd(current.originalEnd);
      setAngleStep(current.originalAngleStep);
      setMessage("Handle drag cancelled. The wall draft is unchanged.");
    } else {
      moveHandleDrag(event);
      setMessage("Wall endpoint updated in local draft; IFC and project history remain unchanged.");
    }
    endpointDrag = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // Pointer capture retargets the synthetic click to the SVG canvas.
    ignoreCanvasClick = true;
    window.setTimeout(() => { ignoreCanvasClick = false; }, 0);
  };
  const handleArrowKey = (
    endpoint: Endpoint,
    event: KeyboardEvent & { currentTarget: SVGCircleElement },
  ) => {
    const delta = gridEnabled() ? GRID_METRES : 0.05;
    const changes: Record<string, PlanPoint> = {
      ArrowUp: [0, delta],
      ArrowDown: [0, -delta],
      ArrowLeft: [-delta, 0],
      ArrowRight: [delta, 0],
    };
    const change = changes[event.key];
    if (!change) return;
    event.preventDefault();
    event.stopPropagation();
    const point = endpoint === "start" ? start() : (constrainedEnd() ?? end());
    if (!point) return;
    if (angleStep() > 0 && end()) {
      const constrained = constrainedEnd();
      if (constrained) setEnd([constrained[0], constrained[1]]);
      setAngleStep(0);
    }
    const moved: PlanPoint = [
      Math.round((point[0] + change[0]) * 1e9) / 1e9,
      Math.round((point[1] + change[1]) * 1e9) / 1e9,
    ];
    if (endpoint === "start") setStart(moved);
    else setEnd(moved);
    setMessage("Keyboard-adjusted wall " + endpoint + " handle; IFC remains unchanged.");
  };
  const clickPlan = (event: MouseEvent & { currentTarget: SVGSVGElement }) => {
    if (ignoreCanvasClick || endpointDrag || wallTranslation) { ignoreCanvasClick = false; return; }
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
    const intent = serializeWallDraftIntent(wall);
    const url = URL.createObjectURL(new Blob([intent], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "teldra-wall-draft.json";
    document.body.append(a);
    try { a.click(); } finally { a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 5_000); }
  };
  const exportSelectedWallEdit = () => {
    const wall = validDraft();
    const target = props.selectedWallGlobalId?.();
    if (!wall || !end() || !target) {
      setMessage("Select an IFC wall and complete the replacement geometry before exporting.");
      return;
    }
    try {
      // Capture the live selected GlobalId at export time, never a stale ID
      // from a previous selection or pending agent proposal.
      const intent = serializeExistingWallEditIntent(wall, target);
      const url = URL.createObjectURL(new Blob([intent], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "teldra-wall-edit.json";
      document.body.append(link);
      try { link.click(); }
      finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 5_000); }
      setMessage("Exported a reviewed EditWall handoff. IFC remains unchanged; only architecture-only archives are eligible for the separate writer.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const corners = () => {
    const wall = validDraft();
    if (!wall) return "";
    return straightWallFootprint(wall).map(p => toScreen(p).join(",")).join(" ");
  };
  const gridLines = Array.from({ length: 31 }, (_, index) => index - 15);

  return <section aria-label="Wall plan draft" class="teldra-wall-plan-draft">
    <h3>Draw wall — 2D plan</h3>
    <p>Drag the amber endpoint handles to reshape a completed wall, or drag its centreline to translate the entire wall. Arrow keys nudge the focused handle or centreline by 0.25 m with grid snapping, or 0.05 m without it. Escape cancels an active drag. The numeric controls provide exact metre input.</p>
    <p>Click the start and end points, or enter exact coordinates. Units are metres. Choose which face of the wall you are drawing, as in BIM parametric wall tools. This remains a reviewable CAD draft; it cannot yet modify or save IFC walls.</p>
    <div role="group" aria-label="Wall drafting constraints">
      <label><input type="checkbox" checked={gridEnabled()} onChange={event => setGridEnabled(event.currentTarget.checked)} /> Snap to 0.25 m grid</label>
      <label>Angle constraint
        <select value={angleStep()} onChange={event => setAngleStep(Number(event.currentTarget.value))}>
          <option value="0">Off</option><option value="15">15°</option><option value="30">30°</option>
          <option value="45">45°</option><option value="90">90°</option>
        </select>
      </label>
    </div>
    <fieldset class="teldra-wall-plan-draft__baseline">
      <legend>Wall reference line</legend>
      <div role="group" aria-label="Wall reference baseline">
        <For each={["exterior", "centreline", "interior"] as const}>{mode =>
          <button type="button" aria-pressed={baseline() === mode}
            onClick={() => chooseBaseline(mode)}>
            {mode === "exterior" ? "Exterior face" : mode === "centreline" ? "Centreline" : "Interior face"}
          </button>
        }</For>
      </div>
      <p>Exterior is the left face from start to end; interior is the right. Switching reference does not move a completed wall. IFC exports always contain its centreline.</p>
    </fieldset>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Interactive metre-based wall plan, click twice to draw a wall"
      tabindex="0"
      style={{ width: "100%", "max-width": "640px", "background-color": "var(--surface, #1b1b1b)", "touch-action": "manipulation", cursor: "crosshair" }}
      onClick={clickPlan} onMouseMove={movePlan} onMouseLeave={() => setPointer(null)}
      onPointerMove={event => { moveHandleDrag(event); moveWallTranslation(event); }}
      onPointerUp={event => { finishHandleDrag(event, false); finishWallTranslation(event, false); }}
      onPointerCancel={event => { finishHandleDrag(event, true); finishWallTranslation(event, true); }}
      onKeyDown={event => {
        if (event.key !== "Escape") return;
        const handle = endpointDrag;
        const translation = wallTranslation;
        if (!handle && !translation) return;
        event.preventDefault();
        event.stopPropagation();
        endpointDrag = null;
        wallTranslation = null;
        const drag = handle ?? translation!;
        setStart(drag.originalStart);
        setEnd(drag.originalEnd);
        setAngleStep(drag.originalAngleStep);
        if (event.currentTarget.hasPointerCapture(drag.pointerId))
          event.currentTarget.releasePointerCapture(drag.pointerId);
        ignoreCanvasClick = true;
        window.setTimeout(() => { ignoreCanvasClick = false; }, 0);
        setMessage("Wall drag cancelled. The draft is unchanged.");
      }}>
      <For each={gridLines}>{v => <>
        <line x1={WIDTH / 2 + v * PIXELS_PER_METRE} y1="0" x2={WIDTH / 2 + v * PIXELS_PER_METRE} y2={HEIGHT} stroke="currentColor" stroke-opacity=".12" />
        <line x1="0" y1={HEIGHT / 2 + v * PIXELS_PER_METRE} x2={WIDTH} y2={HEIGHT / 2 + v * PIXELS_PER_METRE} stroke="currentColor" stroke-opacity=".12" />
      </>}</For>
      <line x1={WIDTH / 2} x2={WIDTH / 2} y1="0" y2={HEIGHT} stroke="currentColor" stroke-opacity=".35" />
      <line x1="0" x2={WIDTH} y1={HEIGHT / 2} y2={HEIGHT / 2} stroke="currentColor" stroke-opacity=".35" />
      <Show when={validDraft()}><polygon points={corners()} fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="2" /></Show>
      <Show when={end() && start() && constrainedEnd()}>{() => <line
        data-testid="wall-translate-handle" role="button" aria-label="Move entire wall" tabindex="0"
        x1={toScreen(start()!)[0]} y1={toScreen(start()!)[1]}
        x2={toScreen(constrainedEnd()!)[0]} y2={toScreen(constrainedEnd()!)[1]}
        stroke="#e6bb77" stroke-opacity=".01" stroke-width="22"
        style={{ cursor: "move", "touch-action": "none", "pointer-events": "stroke" }}
        onPointerDown={beginWallTranslation}
        onKeyDown={nudgeWall}
        onClick={event => { ignoreCanvasClick = false; event.stopPropagation(); }}
      />}</Show>
      <Show when={pendingProposal()}>{proposal => <polygon
        data-testid="wall-proposal-footprint"
        points={straightWallFootprint(proposal().intent.wall).map(p => toScreen(p).join(",")).join(" ")}
        fill="none" stroke="#e6bb77" stroke-width="2" stroke-dasharray="6 4" />}</Show>
      <Show when={end() ? start() : null}>{p => <circle
        data-testid="wall-start-handle" role="button" aria-label="Move wall start point" tabindex="0"
        cx={toScreen(p())[0]} cy={toScreen(p())[1]} r="8"
        fill="#e6bb77" stroke="#243746" stroke-width="2"
        style={{ cursor: "grab", "touch-action": "none" }}
        onPointerDown={event => beginHandleDrag("start", event)}
        onKeyDown={event => handleArrowKey("start", event)}
        onClick={event => { ignoreCanvasClick = false; event.stopPropagation(); }}
      />}</Show>
      <Show when={end() && constrainedEnd()}>{p => <circle
        data-testid="wall-end-handle" role="button" aria-label="Move wall end point" tabindex="0"
        cx={toScreen(p())[0]} cy={toScreen(p())[1]} r="8"
        fill="#e6bb77" stroke="#243746" stroke-width="2"
        style={{ cursor: "grab", "touch-action": "none" }}
        onPointerDown={event => beginHandleDrag("end", event)}
        onKeyDown={event => handleArrowKey("end", event)}
        onClick={event => { ignoreCanvasClick = false; event.stopPropagation(); }}
      />}</Show>
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
      <Show when={validDraft()}>{wall => <p data-testid="wall-ifc-centreline">IFC centreline: ({wall().start.map(n => n.toFixed(3)).join(", ")}) to ({wall().end.map(n => n.toFixed(3)).join(", ")}) m</p>}</Show>
    </fieldset>
    <details class="teldra-wall-plan-draft__proposal-review">
      <summary>Review imported or agent-proposed wall draft</summary>
      <p>Paste a versioned wall draft JSON proposal. Preview and accept it explicitly. Neither preview nor acceptance edits the IFC building or saves the project.</p>
      <label for="wall-proposal-json">Wall draft JSON</label>
      <textarea id="wall-proposal-json" aria-label="Wall draft JSON proposal" rows="5"
        value={proposalInput()} onInput={event => { setProposalInput(event.currentTarget.value); setPendingProposal(null); setProposalMessage(""); }}
        placeholder='{"format":"teldra-wall-draft-v1","operation":"CreateWall",...}' />
      <div role="group" aria-label="Wall proposal review actions">
        <button type="button" disabled={!proposalInput().trim()} onClick={previewProposal}>Preview proposal</button>
        <button type="button" disabled={!pendingProposal()} onClick={acceptProposal}>Accept into draft</button>
        <button type="button" disabled={!pendingProposal() && !proposalInput()} onClick={rejectProposal}>Reject proposal</button>
      </div>
      <Show when={pendingProposal()}>{proposal => <div role="status" aria-label="Proposed wall dimensions">
        <strong>Pending review — not applied (project revision {proposal().baseRevision})</strong>
        <p>From ({proposal().intent.wall.start.join(", ")}) m to ({proposal().intent.wall.end.join(", ")}) m;
          length {Math.hypot(proposal().intent.wall.end[0] - proposal().intent.wall.start[0], proposal().intent.wall.end[1] - proposal().intent.wall.start[1]).toFixed(3)} m;
          thickness {proposal().intent.wall.thicknessMetres} m; height {proposal().intent.wall.heightMetres} m.</p>
      </div>}</Show>
      <Show when={proposalMessage()}><p role="status">{proposalMessage()}</p></Show>
    </details>
    <div role="group" aria-label="Wall draft actions">
      <button type="button" onClick={reset}>Clear draft</button>
      <button type="button" disabled={!validDraft() || !end()} onClick={exportIntent}>Export wall draft JSON</button>
      <Show when={props.selectedWallGlobalId?.()}>{guid => <section aria-label="Selected IFC wall edit handoff">
        <p>Selected IFC wall: <code>{guid()}</code>. The plan contains manually entered replacement geometry; it does not reconstruct the existing wall automatically.</p>
        <button type="button" disabled={!validDraft() || !end()} onClick={exportSelectedWallEdit}>
          Export selected wall edit JSON
        </button>
        <p>Requires an eligible architecture-only archive and separate source SHA-256 verification. Never use for native 21D visual geometry without reconciliation.</p>
      </section>}</Show>
      <button type="button" disabled title="Awaiting IFC-authoritative Studio wall transactions">Apply to IFC (not yet supported)</button>
    </div>
    <Show when={message()}><p role="alert">{message()}</p></Show>
  </section>;
}
