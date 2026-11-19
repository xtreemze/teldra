import { createComputed, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import type { IfcWallChange, IfcWallOperation } from "@teldra/application";
import {
  frameStoreyPlan, overlayWallChanges, planToCanonical, projectStoreyPlan,
  type PlanPoint, type PlanViewport, type PlanWall, type StoreyPlan,
} from "@teldra/projection";
import type { PlanEditingHost } from "./PlanEditingHost";
import {
  moveEndpoint, newIfcGlobalId, resizeWallLength, snapPlanPoint, translateWall, tryApply, tryPreview, updateOp, wallEndpoints, wallSegments,
  geometryOf, type SnapKind, type WallEndName,
} from "./planEditing";
import { axisDisplacement, hasTypedEntry, NO_ENTRY, parseTyped, polarTarget, type AxisConstraint, type TypedEntry } from "./planTyped";
import "./PlanView.css";

const WIDTH = 640;
const HEIGHT = 420;
const HANDLE_PICK_PIXELS = 12;
const GRID_SIZES = [0.05, 0.1, 0.25, 0.5, 1] as const;
const SNAP_LABELS: Record<SnapKind, string> = { endpoint: "Endpoint", midpoint: "Midpoint", perpendicular: "Perpendicular", angle: "Angle", grid: "Grid", none: "" };
const MOVE_THRESHOLD_PIXELS = 3;
const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
const points = (ring: readonly PlanPoint[]) => ring.map((p) => `${p[0]},${p[1]}`).join(" ");
let instances = 0;

type Drag =
  | { readonly kind: "endpoint"; readonly pointerId: number; readonly wall: PlanWall; readonly end: WallEndName; op: IfcWallOperation | null }
  | { readonly kind: "wall"; readonly pointerId: number; readonly wall: PlanWall; readonly origin: PlanPoint; moved: boolean; op: IfcWallOperation | null };

/**
 * Plan view of the canonical IFC walls of one storey. Rendering is a projection of IFC bytes (never the
 * source of truth); every edit is previewed with `editor.preview()` and committed with `editor.apply()` on
 * the host's shared `IfcWallEditor`, so 2D and 3D share one command history. Escape cancels a gesture.
 */
export function PlanView(props: { host: PlanEditingHost; /** Optional reactive revision (e.g. controller.revision) so external edits refresh the plan. */ revision?: () => number }) {
  const uid = `teldra-plan-${++instances}`;
  const editor = () => props.host.wallEditor;
  const [version, setVersion] = createSignal(0);
  const refresh = () => setVersion((v) => v + 1);
  const source = createMemo(() => { version(); props.revision?.(); return props.host.readPlanSource(editor().bytes); });
  const storeys = () => props.host.storeys ?? source().storeys;
  const [storeyChoice, setStoreyChoice] = createSignal<string | null>(null);
  const storey = createMemo(() => { const list = storeys(); return list.find((s) => s.globalId === storeyChoice()) ?? list[0] ?? null; });
  const [viewport, setViewport] = createSignal<PlanViewport | null>(null);
  const fit = () => { const s = storey(); if (s) setViewport(frameStoreyPlan(untrack(source), s.globalId, { width: WIDTH, height: HEIGHT })); };
  createComputed(on(() => storey()?.globalId, fit));

  const basePlan = createMemo((): StoreyPlan | null => {
    const s = storey(), vp = viewport();
    if (!s || !vp) return null;
    try { return projectStoreyPlan(source(), s.globalId, vp, { canonicalIdByGlobalId: props.host.canonicalIdByGlobalId?.() }); }
    catch { return null; }
  });
  const [preview, setPreview] = createSignal<readonly IfcWallChange[] | null>(null);
  const plan = createMemo(() => { const base = basePlan(), changes = preview(); return base && changes ? overlayWallChanges(base, changes) : base; });

  const [tool, setTool] = createSignal<"select" | "draw">("select");
  const [info, setInfo] = createSignal("Select a wall, or choose Draw wall. Escape cancels the current gesture.");
  const [refusal, setRefusal] = createSignal<string | null>(null);
  const [gridEnabled, setGridEnabled] = createSignal(true);
  const [gridMetres, setGridMetres] = createSignal<number>(0.25);
  // Typed numeric entry during a gesture (Tab switches length/angle, X/Y constrain the axis).
  const [lengthText, setLengthText] = createSignal("");
  const [angleText, setAngleText] = createSignal("");
  const [typedField, setTypedField] = createSignal<"length" | "angle">("length");
  const [axis, setAxis] = createSignal<AxisConstraint>(null);
  const entry = (): TypedEntry => ({ length: parseTyped(lengthText()), angleDegrees: parseTyped(angleText()), axis: axis() });
  const resetEntry = () => { setLengthText(""); setAngleText(""); setTypedField("length"); setAxis(null); };
  const [dragging, setDragging] = createSignal<"endpoint" | "wall" | null>(null);
  let lastRaw: PlanPoint | null = null;
  let draftEnd: PlanPoint | null = null;
  const [angleStep, setAngleStep] = createSignal(45);
  const [snap, setSnap] = createSignal<{ point: PlanPoint; kind: SnapKind } | null>(null);
  const [drawThickness, setDrawThickness] = createSignal(0.2);
  const [drawHeight, setDrawHeight] = createSignal(2.5);
  const [draftStart, setDraftStart] = createSignal<PlanPoint | null>(null);
  let draftId: string | null = null;
  let svg!: SVGSVGElement;
  let drag: Drag | null = null;
  let suppressNextClick = false;

  const [selected, setSelected] = createSignal<string | null>(null);
  createEffect(() => setSelected(props.host.selection.get()));
  const select = (id: string | null) => { setSelected(id); props.host.selection.set(id); };
  const selectedWall = createMemo(() => basePlan()?.walls.find((w) => w.ifcGlobalId === selected()) ?? null);
  const displayedSelected = () => plan()?.walls.find((w) => w.ifcGlobalId === selected()) ?? null;

  const history = () => { version(); props.revision?.(); return editor().history; };
  const toCanonical = (event: { clientX: number; clientY: number }): PlanPoint => {
    const rect = svg.getBoundingClientRect(), vp = viewport()!;
    return planToCanonical(vp, [(event.clientX - rect.left) * WIDTH / rect.width, (event.clientY - rect.top) * HEIGHT / rect.height]);
  };
  const snapRadius = () => HANDLE_PICK_PIXELS / (viewport()?.pixelsPerMetre ?? 32);

  const showRefusal = (message: string) => { setPreview(null); setRefusal(message); setInfo(""); };
  const runPreview = (operation: IfcWallOperation): boolean => {
    const outcome = tryPreview(editor(), operation);
    if (outcome.ok) { setPreview(outcome.changes); setRefusal(null); return true; }
    showRefusal(outcome.message); return false;
  };
  const commit = (operations: IfcWallOperation | readonly IfcWallOperation[], done: string): boolean => {
    const outcome = tryApply(editor(), operations);
    setPreview(null);
    if (!outcome.ok) { showRefusal(outcome.message); return false; }
    setRefusal(null);
    const connected = outcome.changes.filter((c) => c.cause === "connected").length;
    setInfo(`${done}${connected ? ` ${connected} connected wall${connected === 1 ? "" : "s"} followed.` : ""} Undo restores the previous IFC.`);
    refresh();
    props.host.onCommitted();
    return true;
  };
  const cancelGesture = (): boolean => {
    const active = drag !== null || draftStart() !== null || preview() !== null;
    if (!active) return false;
    if (drag && svg?.hasPointerCapture(drag.pointerId)) svg.releasePointerCapture(drag.pointerId);
    drag = null; setDragging(null); draftId = null; draftEnd = null; setDraftStart(null); setPreview(null); setSnap(null); setRefusal(null); resetEntry();
    setInfo("Edit cancelled. IFC is unchanged.");
    suppressNextClick = true; window.setTimeout(() => { suppressNextClick = false; }, 0);
    return true;
  };
  const onWindowKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { if (cancelGesture()) event.preventDefault(); return; }
    if (onGestureKey(event)) { event.preventDefault(); event.stopPropagation(); }
  };
  onMount(() => window.addEventListener("keydown", onWindowKey));
  onCleanup(() => window.removeEventListener("keydown", onWindowKey));

  const snapOptions = (anchor: PlanPoint | null, excludedWalls: ReadonlySet<string>, excludedPoints: readonly PlanPoint[]) => ({
    gridEnabled: gridEnabled(), gridMetres: gridMetres(), angleStepDegrees: angleStep(), anchor, endpointRadiusMetres: snapRadius(),
    endpoints: wallEndpoints(basePlan()?.walls ?? [], excludedWalls, excludedPoints),
    segments: wallSegments(basePlan()?.walls ?? [], excludedWalls),
  });

  // ---- select tool: endpoint + whole-wall drags
  const beginEndpointDrag = (wall: PlanWall, end: WallEndName, event: PointerEvent) => {
    if (drag || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation();
    drag = { kind: "endpoint", pointerId: event.pointerId, wall, end, op: null };
    setDragging("endpoint");
    svg.setPointerCapture(event.pointerId);
    setInfo(`Dragging the ${end} point. Release applies; Escape cancels.`);
  };
  const beginWallDrag = (wall: PlanWall, event: PointerEvent) => {
    if (tool() !== "select" || drag || !event.isPrimary) return;
    event.stopPropagation();
    select(wall.ifcGlobalId);
    drag = { kind: "wall", pointerId: event.pointerId, wall, origin: toCanonical(event), moved: false, op: null };
    setDragging("wall");
    svg.setPointerCapture(event.pointerId);
  };
  /** The edited wall plus walls that follow it (joined at the edited end, or any joint when the whole wall moves): not snap targets. */
  const followers = (wall: PlanWall, end: WallEndName | null): ReadonlySet<string> =>
    new Set([wall.ifcGlobalId, ...wall.connections.filter((c) => end === null || c.end === end).map((c) => c.wallGlobalId)]);
  /** Recomputes the active gesture's target from the pointer plus typed entry/axis, and previews it via editor.preview(). */
  const updateGesture = (raw: PlanPoint) => {
    lastRaw = raw;
    const typed = entry(), typedActive = hasTypedEntry(typed);
    const current = drag;
    if (current?.kind === "endpoint") {
      const other: WallEndName = current.end === "start" ? "end" : "start";
      let result: { point: PlanPoint; kind: SnapKind };
      if (typedActive && typed.axis) result = { point: axisDisplacement(current.wall[current.end], raw, current.wall[current.end], typed), kind: "none" };
      else if (typedActive) result = { point: polarTarget(current.wall[other], raw, typed), kind: "none" };
      else result = snapPlanPoint(raw, snapOptions(current.wall[other], followers(current.wall, null), [current.wall[current.end]]));
      setSnap(result);
      const op = updateOp(current.wall.ifcGlobalId, moveEndpoint(current.wall, current.end, result.point));
      current.op = runPreview(op) ? op : null;
    } else if (current?.kind === "wall") {
      const rect = svg.getBoundingClientRect(), vp = viewport()!;
      const metresPerClientPixel = WIDTH / rect.width / vp.pixelsPerMetre;
      if (!current.moved && !typedActive && Math.hypot(raw[0] - current.origin[0], raw[1] - current.origin[1]) < MOVE_THRESHOLD_PIXELS * metresPerClientPixel) return;
      current.moved = true;
      let result: { point: PlanPoint; kind: SnapKind };
      if (typedActive) result = { point: axisDisplacement(current.wall.start, raw, current.origin, typed), kind: "none" };
      else {
        const wanted: PlanPoint = [current.wall.start[0] + raw[0] - current.origin[0], current.wall.start[1] + raw[1] - current.origin[1]];
        result = snapPlanPoint(wanted, { ...snapOptions(null, followers(current.wall, null), []), angleStepDegrees: 0 });
      }
      setSnap(result);
      const op = updateOp(current.wall.ifcGlobalId, translateWall(current.wall, result.point));
      current.op = runPreview(op) ? op : null;
    } else if (tool() === "draw" && storey()) {
      const start = draftStart();
      const result = start && typedActive ? { point: polarTarget(start, raw, typed), kind: "none" as SnapKind } : snapPlanPoint(raw, snapOptions(start, new Set(), []));
      setSnap(result);
      draftEnd = start ? result.point : null;
      if (start && draftId && Math.hypot(result.point[0] - start[0], result.point[1] - start[1]) > 1e-6) runPreview(createOp(start, result.point));
    }
  };
  const moveDrag = (event: PointerEvent) => {
    if (drag && event.pointerId === drag.pointerId) updateGesture(toCanonical(event));
  };
  const finishDrag = (cancelled: boolean) => {
    const current = drag;
    if (!current) return;
    drag = null; setDragging(null); setSnap(null); resetEntry();
    if (svg.hasPointerCapture(current.pointerId)) svg.releasePointerCapture(current.pointerId);
    suppressNextClick = true; window.setTimeout(() => { suppressNextClick = false; }, 0);
    if (cancelled) { cancelGesture(); return; }
    if (current.kind === "wall" && !current.moved) { setPreview(null); setInfo(`Selected ${current.wall.name}.`); return; }
    if (current.op) commit(current.op, current.kind === "endpoint" ? `Moved ${current.wall.name} ${current.end} point.` : `Moved ${current.wall.name}.`);
    else setPreview(null);
  };
  const endDrag = (event: PointerEvent, cancelled: boolean) => { if (drag && event.pointerId === drag.pointerId) finishDrag(cancelled); };

  // ---- draw tool
  const drawGeometry = (start: PlanPoint, end: PlanPoint) =>
    ({ start: start as [number, number], end: end as [number, number], thickness: drawThickness(), height: drawHeight(), elevation: storey()?.elevation ?? 0 });
  const createOp = (start: PlanPoint, end: PlanPoint): IfcWallOperation => ({
    kind: "create", globalId: draftId!, storeyGlobalId: storey()!.globalId, name: `Wall ${(basePlan()?.walls.length ?? 0) + 1}`, geometry: drawGeometry(start, end),
  });
  const commitDraft = (): boolean => {
    const start = draftStart(), end = draftEnd;
    if (!start || !end || !draftId) return false;
    if (!commit(createOp(start, end), "Created wall.")) return false;
    select(draftId);
    draftId = null; draftEnd = null; setDraftStart(null); resetEntry(); setSnap(null);
    return true;
  };
  const pointerDownCanvas = (event: PointerEvent) => {
    if (!event.isPrimary || drag || !viewport()) return;
    if (tool() === "select") { if (selected()) { select(null); setInfo("Selection cleared."); } return; }
    if (!storey()) return;
    const raw = toCanonical(event);
    if (!draftStart()) {
      const result = snapPlanPoint(raw, snapOptions(null, new Set(), []));
      draftId = newIfcGlobalId(new Set(source().walls.map((w) => w.globalId)));
      setDraftStart(result.point);
      setInfo("Click the end point, or type a length (Tab: angle, X/Y: axis) and press Enter. Escape cancels.");
      return;
    }
    updateGesture(raw);
    commitDraft();
  };
  const pointerMoveCanvas = (event: PointerEvent) => {
    if (drag) { moveDrag(event); return; }
    if (!viewport()) return;
    if (tool() === "draw") updateGesture(toCanonical(event));
    else lastRaw = toCanonical(event);
  };
  // Typed entry while a gesture is active (window-level so focus can stay on the canvas).
  const gestureActive = () => dragging() !== null || (tool() === "draw" && draftStart() !== null);
  const onGestureKey = (event: KeyboardEvent): boolean => {
    if (!gestureActive() || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return false;
    const polar = axis() === null && dragging() !== "wall";
    const setText = (fn: (t: string) => string) => (typedField() === "angle" && polar ? setAngleText(fn) : setLengthText(fn));
    const rerun = () => { if (lastRaw) updateGesture(lastRaw); };
    if (/^[0-9.]$/.test(event.key)) { setText((t) => t + event.key); rerun(); return true; }
    if (event.key === "-") { setText((t) => (t.startsWith("-") ? t.slice(1) : "-" + t)); rerun(); return true; }
    if (event.key === "Backspace") { setText((t) => t.slice(0, -1)); rerun(); return true; }
    if (event.key === "Tab" && polar) { setTypedField((f) => (f === "length" ? "angle" : "length")); return true; }
    if (event.key === "x" || event.key === "X" || event.key === "y" || event.key === "Y") {
      const next = event.key.toLowerCase() as "x" | "y";
      setAxis((a) => (a === next ? null : next));
      setAngleText(""); setTypedField("length");
      rerun(); return true;
    }
    if (event.key === "Enter") { if (drag) finishDrag(false); else commitDraft(); return true; }
    return false;
  };

  // ---- keyboard + numeric
  const nudge = (wall: PlanWall, end: WallEndName | "wall", dx: number, dy: number) => {
    const geometry = end === "wall" ? translateWall(wall, [wall.start[0] + dx, wall.start[1] + dy]) : moveEndpoint(wall, end, [wall[end][0] + dx, wall[end][1] + dy]);
    commit(updateOp(wall.ifcGlobalId, geometry), end === "wall" ? `Moved ${wall.name}.` : `Moved ${wall.name} ${end} point.`);
  };
  const arrow = (event: KeyboardEvent, wall: PlanWall, end: WallEndName | "wall") => {
    const step = gridEnabled() ? gridMetres() : 0.05;
    const delta: Record<string, PlanPoint> = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] };
    const d = delta[event.key];
    if (!d) return false;
    event.preventDefault(); event.stopPropagation();
    nudge(wall, end, d[0], d[1]);
    return true;
  };
  const deleteSelected = () => {
    const wall = selectedWall();
    if (!wall) return;
    if (commit({ kind: "remove", globalId: wall.ifcGlobalId }, `Deleted ${wall.name}.`)) select(null);
  };
  type Field = "length" | "thickness" | "height";
  const geometryFor = (wall: PlanWall, field: Field, value: number) =>
    field === "length" ? resizeWallLength(wall, value) : { ...geometryOf(wall), [field]: value };
  const currentValue = (wall: PlanWall, field: Field) => (field === "length" ? wall.length : wall[field]);
  const parse = (input: HTMLInputElement) => (input.value.trim() === "" ? NaN : Number(input.value));
  const previewField = (wall: PlanWall, field: Field, input: HTMLInputElement) => {
    const value = parse(input);
    try { runPreview(updateOp(wall.ifcGlobalId, geometryFor(wall, field, value))); }
    catch (error) { showRefusal(`Refused: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const commitField = (wall: PlanWall, field: Field, input: HTMLInputElement) => {
    const value = parse(input);
    if (Math.abs(value - currentValue(wall, field)) < 1e-9) { setPreview(null); return; }
    let ok = false;
    try { ok = commit(updateOp(wall.ifcGlobalId, geometryFor(wall, field, value)), `Set ${wall.name} ${field} to ${fmt(value)} m.`); }
    catch (error) { showRefusal(`Refused: ${error instanceof Error ? error.message : String(error)}`); }
    if (!ok) input.value = fmt(currentValue(wall, field));
  };
  const revert = (wall: PlanWall, field: Field, input: HTMLInputElement) => { input.value = fmt(currentValue(wall, field)); setPreview(null); setRefusal(null); setInfo("Edit cancelled. IFC is unchanged."); };
  const NumberField = (p: { wall: PlanWall; field: Field; label: string }) => <label>
    {p.label}
    <input type="number" step="0.01" min="0.001" inputMode="decimal" value={fmt(currentValue(p.wall, p.field))}
      data-testid={`plan-field-${p.field}`}
      onInput={(event) => previewField(p.wall, p.field, event.currentTarget)}
      onChange={(event) => commitField(p.wall, p.field, event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); revert(p.wall, p.field, event.currentTarget); }
        else if (event.key === "Enter") { event.preventDefault(); commitField(p.wall, p.field, event.currentTarget); }
      }} />
  </label>;

  const undo = () => { if (editor().undo()) { setPreview(null); setRefusal(null); setInfo("Undid the last IFC wall edit."); refresh(); props.host.onCommitted(); } };
  const redo = () => { if (editor().redo()) { setPreview(null); setRefusal(null); setInfo("Redid the IFC wall edit."); refresh(); props.host.onCommitted(); } };

  const centroid = (ring: readonly PlanPoint[]): PlanPoint => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  const gridStep = () => gridMetres() * (viewport()?.pixelsPerMetre ?? 32);
  const wallLabel = (wall: PlanWall) => `${wall.name}, ${fmt(wall.length)} m long, ${fmt(wall.thickness)} m thick${wall.hostsOpenings ? ", hosts an opening" : ""}`;

  return <section class="teldra-plan-view" aria-label="Storey plan editor" onKeyDown={(event) => {
    if ((event.key === "Delete" || event.key === "Backspace") && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) && selectedWall()) { event.preventDefault(); deleteSelected(); }
  }}>
    <div class="teldra-plan-view__toolbar" role="toolbar" aria-label="Plan editing tools">
      <button type="button" aria-pressed={tool() === "select"} onClick={() => { cancelGesture(); setTool("select"); }}>Select</button>
      <button type="button" aria-pressed={tool() === "draw"} onClick={() => { setTool("draw"); setInfo("Click the wall start point."); }}>Draw wall</button>
      <button type="button" disabled={!selectedWall()} onClick={deleteSelected}>Delete wall</button>
      <button type="button" disabled={!history().canUndo} onClick={undo}>Undo</button>
      <button type="button" disabled={!history().canRedo} onClick={redo}>Redo</button>
      <button type="button" onClick={fit}>Fit</button>
      <Show when={storeys().length > 0}>
        <label>Storey
          <select value={storey()?.globalId ?? ""} onChange={(event) => { cancelGesture(); select(null); setStoreyChoice(event.currentTarget.value); }}>
            <For each={storeys()}>{(s) => <option value={s.globalId}>{s.name}</option>}</For>
          </select>
        </label>
      </Show>
      <label><input type="checkbox" checked={gridEnabled()} onChange={(event) => setGridEnabled(event.currentTarget.checked)} /> Grid snap</label>
      <label>Grid size
        <select value={String(gridMetres())} onChange={(event) => setGridMetres(Number(event.currentTarget.value))}>
          <For each={GRID_SIZES}>{(size) => <option value={String(size)}>{size} m</option>}</For>
        </select>
      </label>
      <label>Angle snap
        <select value={String(angleStep())} onChange={(event) => setAngleStep(Number(event.currentTarget.value))}>
          <option value="0">Off</option><option value="15">15°</option><option value="45">45°</option><option value="90">90°</option>
        </select>
      </label>
      <output data-testid="plan-history">{history().undoDepth} undo / {history().redoDepth} redo</output>
    </div>
    <Show when={tool() === "draw"}>
      <div class="teldra-plan-view__draw-defaults" role="group" aria-label="New wall dimensions">
        <label>New wall thickness (m)<input type="number" step="0.01" min="0.01" value={drawThickness()} onChange={(event) => { const v = Number(event.currentTarget.value); if (v > 0) setDrawThickness(v); }} /></label>
        <label>New wall height (m)<input type="number" step="0.1" min="0.1" value={drawHeight()} onChange={(event) => { const v = Number(event.currentTarget.value); if (v > 0) setDrawHeight(v); }} /></label>
      </div>
    </Show>
    <Show when={plan()} fallback={<p class="teldra-plan-view__empty">This model has no storey to plan.</p>}>{(current) =>
      <svg ref={svg} class="teldra-plan-view__canvas" data-tool={tool()} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width={WIDTH} height={HEIGHT}
        role="group" aria-label={`Plan of ${current().storey.name}. Units are metres.`}
        onPointerDown={pointerDownCanvas} onPointerMove={pointerMoveCanvas}
        onPointerUp={(event) => endDrag(event, false)} onPointerCancel={(event) => endDrag(event, true)}
        onClick={(event) => { if (suppressNextClick) event.stopPropagation(); }}
        onPointerLeave={() => { if (!drag) setSnap(null); }}>
        <defs>
          <pattern id={`${uid}-grid`} width={gridStep()} height={gridStep()} patternUnits="userSpaceOnUse"
            x={current().viewport.width / 2 - current().viewport.centre[0] * current().viewport.pixelsPerMetre}
            y={current().viewport.height / 2 + current().viewport.centre[1] * current().viewport.pixelsPerMetre}>
            <path d={`M ${gridStep()} 0 L 0 0 0 ${gridStep()}`} class="teldra-plan-view__grid" />
          </pattern>
        </defs>
        <rect width={WIDTH} height={HEIGHT} class="teldra-plan-view__background" />
        <Show when={gridEnabled() && gridStep() >= 6}><rect width={WIDTH} height={HEIGHT} fill={`url(#${uid}-grid)`} pointer-events="none" /></Show>
        <For each={current().spaces}>{(space) => <g class="teldra-plan-view__space" data-ifc-global-id={space.ifcGlobalId} pointer-events="none">
          <polygon points={points(space.planFootprint)} />
          <text x={centroid(space.planFootprint)[0]} y={centroid(space.planFootprint)[1]} text-anchor="middle">{space.name}</text>
        </g>}</For>
        <For each={current().walls}>{(wall) => <g class="teldra-plan-view__wall" role="button" tabindex="0"
          data-testid={`plan-wall-${wall.ifcGlobalId}`} data-ifc-global-id={wall.ifcGlobalId} data-canonical-id={wall.canonicalId ?? undefined}
          data-selected={wall.ifcGlobalId === selected() ? "true" : "false"} data-preview={wall.preview ? "true" : "false"} data-hosted={wall.hostsOpenings ? "true" : "false"}
          aria-label={wallLabel(wall)} aria-pressed={wall.ifcGlobalId === selected()}
          onPointerDown={(event) => beginWallDrag(wall, event)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(wall.ifcGlobalId); setInfo(`Selected ${wall.name}.`); }
            else if (wall.ifcGlobalId === selected() && !wall.preview) arrow(event, wall, "wall");
          }}>
          <polygon points={points(wall.planOutline)} />
          <line x1={wall.planStart[0]} y1={wall.planStart[1]} x2={wall.planEnd[0]} y2={wall.planEnd[1]} />
        </g>}</For>
        <For each={current().openings}>{(opening) => <polygon class="teldra-plan-view__opening" points={points(opening.planFootprint)}
          data-ifc-global-id={opening.ifcGlobalId} data-opening-kind={opening.openingKind} pointer-events="none" />}</For>
        <For each={current().walls}>{(wall) => <For each={wall.connections}>{(link) => {
          const at = link.end === "start" ? wall.planStart : wall.planEnd;
          return <circle class="teldra-plan-view__joint" r="4" cx={at[0]} cy={at[1]} data-joint={`${wall.ifcGlobalId}:${link.end}`} pointer-events="none" />;
        }}</For>}</For>
        <Show when={displayedSelected()}>{(wall) => <>
          <For each={["start", "end"] as const}>{(end) => {
            const pos = () => (end === "start" ? wall().planStart : wall().planEnd);
            return <circle class="teldra-plan-view__handle" role="button" tabindex="0" r="7" cx={pos()[0]} cy={pos()[1]}
              data-testid={`plan-handle-${end}`} aria-label={`${wall().name} ${end} point. Drag or use arrow keys.`}
              onPointerDown={(event) => { const base = selectedWall(); if (base) beginEndpointDrag(base, end, event); }}
              onKeyDown={(event) => { const base = selectedWall(); if (base) arrow(event, base, end); }} />;
          }}</For>
          <text class="teldra-plan-view__dimension" x={(wall().planStart[0] + wall().planEnd[0]) / 2} y={(wall().planStart[1] + wall().planEnd[1]) / 2 - 12} text-anchor="middle">{fmt(wall().length)} m</text>
          {(() => {
            const o = wall().planOutline;
            const mx = (o[2][0] + o[3][0]) / 2, my = (o[2][1] + o[3][1]) / 2;
            const cx = (o[0][0] + o[2][0]) / 2, cy = (o[0][1] + o[2][1]) / 2;
            const d = Math.hypot(mx - cx, my - cy) || 1;
            return <text class="teldra-plan-view__dimension" data-testid="plan-thickness-label" x={mx + (mx - cx) / d * 14} y={my + (my - cy) / d * 14 + 4} text-anchor="middle">t {fmt(wall().thickness)} m</text>;
          })()}
        </>}</Show>
        <Show when={snap() && snap()!.kind !== "none"}>
          {(() => { const s = snap()!; const vp = () => current().viewport;
            const x = () => vp().width / 2 + (s.point[0] - vp().centre[0]) * vp().pixelsPerMetre;
            const y = () => vp().height / 2 - (s.point[1] - vp().centre[1]) * vp().pixelsPerMetre;
            return <g class="teldra-plan-view__snap" data-snap={s.kind} data-testid="plan-snap" pointer-events="none">
              <Show when={s.kind === "endpoint"}><rect x={x() - 8} y={y() - 8} width="16" height="16" /></Show>
              <Show when={s.kind === "midpoint"}><polygon points={`${x()},${y() - 9} ${x() - 8},${y() + 6} ${x() + 8},${y() + 6}`} /></Show>
              <Show when={s.kind === "perpendicular"}><path d={`M ${x() - 8} ${y() - 8} L ${x() - 8} ${y() + 8} L ${x() + 8} ${y() + 8} M ${x() - 8} ${y()} L ${x()} ${y()} L ${x()} ${y() + 8}`} /></Show>
              <Show when={s.kind === "angle" || s.kind === "grid"}><path d={`M ${x() - 6} ${y()} L ${x() + 6} ${y()} M ${x()} ${y() - 6} L ${x()} ${y() + 6}`} /></Show>
              <text x={x() + 12} y={y() - 10}>{SNAP_LABELS[s.kind]}</text>
            </g>; })()}
        </Show>
      </svg>
    }</Show>
    <Show when={dragging() !== null || draftStart() !== null}>
      <p class="teldra-plan-view__hud" data-testid="plan-numeric-hud" aria-live="polite">
        <span data-active={typedField() === "length" || axis() !== null}>Length {lengthText() || "–"} m</span>
        <Show when={axis() === null && dragging() !== "wall"}><span data-active={typedField() === "angle"}>Angle {angleText() || "–"}°</span></Show>
        <span>Axis {axis()?.toUpperCase() ?? "free"}</span>
        <small>Type digits · Tab length/angle · X / Y axis · Enter commits · Esc cancels</small>
      </p>
    </Show>
    <p class="teldra-plan-view__message" role="status" data-testid="plan-message">{info()}</p>
    <Show when={refusal()}><p class="teldra-plan-view__refusal" role="alert" data-testid="plan-refusal">{refusal()}</p></Show>
    <Show when={source().unreadable?.length}><p class="teldra-plan-view__message">{source().unreadable!.length} IFC element(s) could not be drawn (unsupported geometry) and are not editable here.</p></Show>
    <Show when={selectedWall()}>{(wall) => <form class="teldra-plan-view__numeric" aria-label={`Dimensions of ${wall().name}`} onSubmit={(event) => event.preventDefault()}>
      <h4>{wall().name} <small>{wall().ifcGlobalId}</small></h4>
      <Show when={wall().hostsOpenings}><p class="teldra-plan-view__hosted">This wall hosts a door or window opening. Edits are refused until opening re-hosting is supported.</p></Show>
      <NumberField wall={wall()} field="length" label="Length (m)" />
      <NumberField wall={wall()} field="thickness" label="Thickness (m)" />
      <NumberField wall={wall()} field="height" label="Height (m)" />
      <p class="teldra-plan-view__hint">Start ({fmt(wall().start[0])}, {fmt(wall().start[1])}) → end ({fmt(wall().end[0])}, {fmt(wall().end[1])}) m. Length keeps the start point and direction.</p>
    </form>}</Show>
  </section>;
}
