import { createEffect, createSignal, For, Show, onMount, onCleanup } from "solid-js";
import type { FurnitureGeometryScale, FurnitureWorldPose } from "@teldra/application";
import type { StudioProjectController } from "./StudioProjectController";

export interface FurnitureEditControls {
  /** Commit exactly the current validated draft through the IFC application command. */
  apply(): boolean;
  cancel(): void;
}

export interface IfcFurnitureEditProps {
  controller: StudioProjectController;
  canonicalId: string;
  externalVersion?: number;
  /** Incremented by the workspace transform action to request a validated gizmo session. */
  editRequest?: number;
  onChange?: () => void;
  onPreview?: (pose: FurnitureWorldPose | null) => void;
  onScalePreview?: (scale: FurnitureGeometryScale | null) => void;
  onScaleUnavailable?: (reason: string) => void;
  viewportScaleDraft?: FurnitureGeometryScale | undefined;
  editMode?: "translate" | "rotate" | "scale";
  onSnapChange?: (metres: number, radians: number) => void;
  onEditingChange?: (editing: boolean) => void;
  onControlsReady?: (controls: FurnitureEditControls | null) => void;
  viewportDraft?: FurnitureWorldPose | undefined;
}
/** A draft is visual only until Apply issues the IFC-aware application command. */
export function IfcFurnitureEdit(props: IfcFurnitureEditProps) {
  const [draft, setDraft] = createSignal<number[] | null>(null);
  const [scaleDraft, setScaleDraft] = createSignal<number[] | null>(null);
  const [scaleReason, setScaleReason] = createSignal("");
  const [invalidDimensionIndex, setInvalidDimensionIndex] = createSignal<number | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [snap, setSnap] = createSignal(0);
  const [rotationSnap, setRotationSnap] = createSignal(0);
  let loadedId: string | null = null;
  let lastHandledEditRequest = 0;
  let beginGeneration = 0;
  const poseToDraft = (pose: FurnitureWorldPose) => [...pose.position, pose.yawRadians * 180 / Math.PI];
  const pose = (): FurnitureWorldPose | null => {
    const v = draft(); if (!v || !v.every(Number.isFinite) || !Number.isFinite(snap()) || snap() < 0 || !Number.isFinite(rotationSnap()) || rotationSnap() < 0) return null;
    const step = snap(); const p = v.slice(0, 3).map((n) => step > 0 ? Math.round(n / step) * step : n) as [number, number, number];
    const degrees = rotationSnap() > 0 ? Math.round(v[3]! / rotationSnap()) * rotationSnap() : v[3]!;
    return { position: p, yawRadians: degrees * Math.PI / 180 };
  };
  const begin = async () => {
    if (busy() || loadedId !== null) return;
    const id = props.canonicalId, generation = ++beginGeneration;
    setBusy(true); setError("");
    try {
      const current = await props.controller.prepareFurnitureEditing(id);
      if (generation === beginGeneration && id === props.canonicalId) {
        const support = props.controller.furnitureScaleStatus(id);
        if (props.editMode === "scale" && !support.supported) {
          setError("Scale unavailable: " + support.reason);
          props.onEditingChange?.(false);
          props.onScaleUnavailable?.(support.reason);
          return;
        }
        loadedId = id;
        setInvalidDimensionIndex(null);
        setDraft(poseToDraft(current));
        setScaleDraft(support.supported ? [...support.scale] : null);
        setScaleReason(support.supported ? "" : support.reason);
        props.onEditingChange?.(true);
        updateSnapping();
      }
    } catch (err) {
      if (generation === beginGeneration) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === beginGeneration) setBusy(false);
    }
  };
  const cancel = () => {
    ++beginGeneration; setBusy(false); setDraft(null); setScaleDraft(null); setInvalidDimensionIndex(null); loadedId = null;
    props.onPreview?.(null); props.onScalePreview?.(null);
    props.onEditingChange?.(false); setError("");
  };
  createEffect(() => {
    const request = props.editRequest ?? 0;
    if (request === 0) { lastHandledEditRequest = 0; return; }
    if (request !== lastHandledEditRequest) {
      lastHandledEditRequest = request;
      if (!loadedId) void begin();
    }
  });
  createEffect(() => { props.externalVersion; const id = props.canonicalId; if (loadedId && id !== loadedId) cancel(); else if (loadedId) {
    try {
      setDraft(poseToDraft(props.controller.furniturePose(id)));
      const support = props.controller.furnitureScaleStatus(id);
      setScaleDraft(support.supported ? [...support.scale] : null);
      props.onPreview?.(null);
    } catch { cancel(); }
  } });
  createEffect(() => { const viewport = props.viewportDraft; if (viewport && loadedId === props.canonicalId) setDraft(poseToDraft(viewport)); });
  createEffect(() => { const scale = props.viewportScaleDraft; if (scale && loadedId === props.canonicalId) setScaleDraft([...scale]); });
  const update = (index: number, value: number) => { setDraft((old) => old?.map((n, i) => i === index ? value : n) ?? null); const next = pose(); if (next) props.onPreview?.(next); };
  const updateScale = (index: number, value: number) => {
    const prior = scaleDraft();
    const next = prior?.map((v, i) => i === index ? value : v);
    if (!next) return;
    setScaleDraft(next);
    if (next.every(v => Number.isFinite(v) && v > 0 && v <= 1000)) {
      try { props.onScalePreview?.(next as [number,number,number]); setInvalidDimensionIndex(null); setError(""); }
      catch (err) {
        setScaleDraft(prior);
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };
  const dimensionStatus = () => {
    const scale = scaleDraft();
    return scale && scale.length === 3 && scale.every(value => Number.isFinite(value) && value > 0 && value <= 1000)
      ? props.controller.furnitureDimensionStatus(props.canonicalId, scale as [number, number, number])
      : { supported: false as const, reason: "Enter valid positive scale factors first." };
  };
  const updateDimension = (index: number, requestedMetres: number) => {
    const current = dimensionStatus();
    if (!current.supported) { setInvalidDimensionIndex(index); setError(current.reason); return; }
    if (!Number.isFinite(requestedMetres) || requestedMetres <= 0 || requestedMetres > 1000) {
      setInvalidDimensionIndex(index);
      setError("Nominal dimensions must be positive finite metre values no greater than 1000.");
      return;
    }
    try {
      const next = [...current.current] as [number, number, number];
      next[index] = requestedMetres;
      const scale = props.controller.furnitureScaleForDimensions(props.canonicalId, next);
      // Renderer validation runs before mutating the editor draft. The source
      // properties remain immutable and Apply still creates one IFC command.
      props.onScalePreview?.(scale);
      setScaleDraft([...scale]);
      setInvalidDimensionIndex(null);
      setError("");
    } catch (error) {
      setInvalidDimensionIndex(index);
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const updateSnapping = () => {
    if ([snap(), rotationSnap()].every(value => Number.isFinite(value) && value >= 0))
      props.onSnapChange?.(snap(), rotationSnap() * Math.PI / 180);
  };
  onMount(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && loadedId) { event.preventDefault(); cancel(); } };
    window.addEventListener("keydown", escape);
    props.onControlsReady?.({apply: applyDraft, cancel});
    onCleanup(() => {
      ++beginGeneration;
      window.removeEventListener("keydown", escape);
      props.onControlsReady?.(null);
    });
  });
  const applyDraft = (): boolean => {
    if (invalidDimensionIndex() !== null) {
      setError("Correct the invalid nominal dimension before applying the IFC edit.");
      return false;
    }
    const next = pose();
    if (!next || loadedId !== props.canonicalId) {
      setError("Enter finite position, rotation and snap values."); return false;
    }
    try {
      const scale = scaleDraft();
      if (scale) {
        if (scale.length !== 3 || scale.some(v => !Number.isFinite(v) || v <= 0 || v > 1000)) {
          setError("Enter finite positive geometry-scale factors at most 1000."); return false;
        }
        props.controller.transformFurniture(props.canonicalId, next, scale as [number,number,number]);
      } else props.controller.placeFurniture(props.canonicalId, next);
      props.onPreview?.(null); props.onScalePreview?.(null);
      setDraft(null); setScaleDraft(null); loadedId = null;
      props.onEditingChange?.(false); setError(""); props.onChange?.();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err)); return false;
    }
  };
  const apply = (event: SubmitEvent) => { event.preventDefault(); applyDraft(); };
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
        <Show when={scaleDraft()} fallback={<p class="teldra-studio-selection-workspace__hint" title={scaleReason()}>Scale unavailable: {scaleReason()}</p>}>
          <fieldset class="teldra-ifc-scale-fields"><legend>IFC mapped geometry scale (local XYZ)</legend>
            <For each={["Scale X", "Scale Y", "Scale Z"]}>{(label, index) =>
              <label>{label} <input type="number" min="0.000001" max="1000" step="any" value={scaleDraft()?.[index()]}
                onInput={event => updateScale(index(), event.currentTarget.valueAsNumber)} /></label>
            }</For>
          </fieldset>
          <Show when={dimensionStatus().supported} fallback={
              <p class="teldra-studio-selection-workspace__hint" data-testid="nominal-dimensions-unavailable">
                Source nominal dimensions unavailable; use the IFC scale factors above.
              </p>
            }>
              <fieldset class="teldra-ifc-scale-fields teldra-ifc-nominal-dimensions" aria-describedby="teldra-nominal-dimensions-description">
                <legend>Authored nominal dimensions (metres)</legend>
                <For each={["Nominal width (m)", "Nominal depth (m)", "Nominal height (m)"]}>{(label, index) =>
                  <label>{label}
                    <input type="number" min="0.000001" max="1000" step="any"
                      value={(() => { const state = dimensionStatus(); return state.supported ? Number(state.current[index()]!.toPrecision(12)) : undefined; })()}
                      aria-invalid={invalidDimensionIndex() === index()}
                      onChange={event => updateDimension(index(), event.currentTarget.valueAsNumber)} />
                  </label>
                }</For>
                <p id="teldra-nominal-dimensions-description" class="teldra-studio-selection-workspace__hint">
                  Source width, depth and height are preserved in IFC provenance. Editing these nominal values
                  changes only the IFC mapped-instance scale, not the original source dimensions or mesh.
                </p>
              </fieldset>
          </Show>
        </Show>
        <button type="submit">Apply placement</button><button type="button" onClick={cancel}>Cancel</button>
      </form>
    </Show>
    <p role={error() ? "alert" : undefined}>{error()}</p>
  </section>;
}
