import { createEffect, createSignal, For, Show, onMount, onCleanup } from "solid-js";
import type { FurnitureWorldPose } from "@teldra/application";
import type { StudioProjectController } from "./StudioProjectController";

export interface IfcFurnitureEditProps {
  controller: StudioProjectController;
  canonicalId: string;
  externalVersion?: number;
  /** Incremented by the workspace transform action to request a validated gizmo session. */
  editRequest?: number;
  onChange?: () => void;
  onPreview?: (pose: FurnitureWorldPose | null) => void;
  onSnapChange?: (metres: number, radians: number) => void;
  onEditingChange?: (editing: boolean) => void;
  viewportDraft?: FurnitureWorldPose | undefined;
}
/** A draft is visual only until Apply issues the IFC-aware application command. */
export function IfcFurnitureEdit(props: IfcFurnitureEditProps) {
  const [draft, setDraft] = createSignal<number[] | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [snap, setSnap] = createSignal(0);
  const [rotationSnap, setRotationSnap] = createSignal(0);
  let loadedId: string | null = null;
  let lastHandledEditRequest = 0;
  const poseToDraft = (pose: FurnitureWorldPose) => [...pose.position, pose.yawRadians * 180 / Math.PI];
  const pose = (): FurnitureWorldPose | null => {
    const v = draft(); if (!v || !v.every(Number.isFinite) || !Number.isFinite(snap()) || snap() < 0 || !Number.isFinite(rotationSnap()) || rotationSnap() < 0) return null;
    const step = snap(); const p = v.slice(0, 3).map((n) => step > 0 ? Math.round(n / step) * step : n) as [number, number, number];
    const degrees = rotationSnap() > 0 ? Math.round(v[3]! / rotationSnap()) * rotationSnap() : v[3]!;
    return { position: p, yawRadians: degrees * Math.PI / 180 };
  };
  const begin = async () => {
    if (busy() || loadedId !== null) return;
    const id = props.canonicalId; setBusy(true); setError("");
    try { const current = await props.controller.prepareFurnitureEditing(id); if (id === props.canonicalId) { loadedId = id; setDraft(poseToDraft(current)); props.onEditingChange?.(true); updateSnapping(); } }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const cancel = () => { setDraft(null); loadedId = null; props.onPreview?.(null); props.onEditingChange?.(false); setError(""); };
  createEffect(() => {
    const request = props.editRequest ?? 0;
    if (request === 0) { lastHandledEditRequest = 0; return; }
    if (request !== lastHandledEditRequest) {
      lastHandledEditRequest = request;
      if (!loadedId) void begin();
    }
  });
  createEffect(() => { props.externalVersion; const id = props.canonicalId; if (loadedId && id !== loadedId) cancel(); else if (loadedId) { try { setDraft(poseToDraft(props.controller.furniturePose(id))); props.onPreview?.(null); } catch { cancel(); } } });
  createEffect(() => { const viewport = props.viewportDraft; if (viewport && loadedId === props.canonicalId) setDraft(poseToDraft(viewport)); });
  const update = (index: number, value: number) => { setDraft((old) => old?.map((n, i) => i === index ? value : n) ?? null); const next = pose(); if (next) props.onPreview?.(next); };
  const updateSnapping = () => {
    if ([snap(), rotationSnap()].every(value => Number.isFinite(value) && value >= 0))
      props.onSnapChange?.(snap(), rotationSnap() * Math.PI / 180);
  };
  onMount(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && loadedId) { event.preventDefault(); cancel(); } };
    window.addEventListener("keydown", escape);
    onCleanup(() => window.removeEventListener("keydown", escape));
  });
  const apply = (event: SubmitEvent) => {
    event.preventDefault(); const next = pose();
    if (!next || loadedId !== props.canonicalId) { setError("Enter finite position, rotation and snap values."); return; }
    try { props.controller.placeFurniture(props.canonicalId, next); props.onPreview?.(null); setDraft(null); loadedId = null; props.onEditingChange?.(false); setError(""); props.onChange?.(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  return <section aria-label="Furniture placement">
    <h3>Furniture placement</h3>
    <p>Position uses IFC world metres, Z up. Rotation is about Z.</p>
    <Show when={draft()} fallback={<button type="button" disabled={busy()} onClick={() => void begin()}>{busy() ? "Checking IFC…" : "Edit placement"}</button>}>
      <form onSubmit={apply}>
        <For each={["Position X (m)", "Position Y (m)", "Position Z (m)", "Rotation (degrees)"]}>{(label, index) =>
          <label>{label} <input type="number" step="any" value={draft()?.[index()]} onInput={(event) => update(index(), event.currentTarget.valueAsNumber)} /></label>
        }</For>
        <label>Position snap (m, 0 off) <input type="number" min="0" step="any" value={snap()} onInput={(event) => { setSnap(event.currentTarget.valueAsNumber); updateSnapping(); }} /></label>
        <label>Rotation snap (degrees, 0 off) <input type="number" min="0" step="any" value={rotationSnap()} onInput={(event) => { setRotationSnap(event.currentTarget.valueAsNumber); updateSnapping(); }} /></label>
        <button type="submit">Apply placement</button><button type="button" onClick={cancel}>Cancel</button>
      </form>
    </Show>
    <p role={error() ? "alert" : undefined}>{error()}</p>
  </section>;
}
