import { createEffect, createSignal, For, Show } from "solid-js";
import type { DevicePlacement } from "@teldra/application";
import type { StudioProjectController } from "./StudioProjectController";

/** Stages edits locally; only Apply issues a canonical application command. */
export function SpatialEdit(props: { controller: StudioProjectController; deviceId: string; onChange?: () => void; externalVersion?: number; hideHistory?: boolean }) {
  const current = () => props.controller.twin.devices.find((device) => device.id === props.deviceId)?.placement;
  const values = () => {
    const p = current();
    return p ? [...p.position, ...p.rotationQuaternion] : [0, 0, 0, 0, 0, 0, 1];
  };
  const [draft, setDraft] = createSignal(values());
  const [step, setStep] = createSignal(0);
  const [message, setMessage] = createSignal("");
  const [version, setVersion] = createSignal(0);
  createEffect(() => { props.externalVersion; props.deviceId; setDraft(values()); });
  const refresh = () => { setVersion((v) => v + 1); setDraft(values()); props.onChange?.(); };
  const update = (index: number, value: number) => setDraft((old) => old.map((item, i) => i === index ? value : item));
  const heading = () => {
    const [, , , x = 0, y = 0, z = 0, w = 1] = draft();
    return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 180 / Math.PI;
  };
  const setHeading = (degrees: number) => {
    const halfAngle = degrees * Math.PI / 360;
    setDraft((old) => [...old.slice(0, 3), 0, 0, Math.sin(halfAngle), Math.cos(halfAngle)]);
  };
  const apply = (event: SubmitEvent) => {
    event.preventDefault();
    const v = draft();
    const snap = step();
    const position = v.slice(0, 3).map((n) => snap > 0 ? Math.round(n / snap) * snap : n) as [number, number, number];
    const q = v.slice(3, 7); const length = Math.hypot(...q);
    if (!v.every(Number.isFinite) || !Number.isFinite(snap) || snap < 0 || length < 1e-12) { setMessage("Enter finite values and a non-zero rotation quaternion."); return; }
    const placement: DevicePlacement = { frame: "ifc-world-metres-z-up", position, rotationQuaternion: q.map((n) => n / length) as [number, number, number, number] };
    try { props.controller.placeDevice(props.deviceId, placement, `studio:place:${props.deviceId}`); setMessage(""); refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  return <section aria-label="Device placement">
    <h3>Device placement</h3>
    <p>Position in metres, with Z up. Heading turns the device around the vertical axis.</p>
    <form onSubmit={apply}>
      <For each={["Position X", "Position Y", "Position Z"]}>{(label, i) =>
        <label>{label} <input type="number" step="any" value={draft()[i()]} onInput={(event) => update(i(), event.currentTarget.valueAsNumber)} /></label>
      }</For>
      <label>Heading (degrees) <input type="number" step="any" value={Number(heading().toFixed(2))} onChange={(event) => setHeading(event.currentTarget.valueAsNumber)} /></label>
      <Show when={Math.abs(draft()[3] ?? 0) > 1e-8 || Math.abs(draft()[4] ?? 0) > 1e-8}><p class="teldra-spatial-edit__warning">Changing heading makes this tilted device upright.</p></Show>
      <details class="teldra-spatial-edit__advanced"><summary>Advanced placement</summary>
        <p>Changing heading makes the device upright. For tilted devices, edit the quaternion directly.</p>
        <div class="teldra-spatial-edit__advanced-fields">
          <For each={["Rotation X", "Rotation Y", "Rotation Z", "Rotation W"]}>{(label, i) =>
            <label>{label} <input type="number" step="any" value={draft()[i() + 3]} onInput={(event) => update(i() + 3, event.currentTarget.valueAsNumber)} /></label>
          }</For>
          <label>Position snap (metres; 0 disables) <input type="number" min="0" step="any" value={step()} onInput={(event) => setStep(event.currentTarget.valueAsNumber)} /></label>
        </div>
      </details>
      <button type="submit">Apply placement</button>
      <button type="button" onClick={() => { setDraft(values()); setMessage(""); }}>Cancel</button>
    </form>
    <Show when={!props.hideHistory}><div aria-label="Placement history and save">
      <button type="button" disabled={(version(), !props.controller.history.canUndo)} onClick={() => { props.controller.undo(); refresh(); }}>Undo</button>
      <button type="button" disabled={(version(), !props.controller.history.canRedo)} onClick={() => { props.controller.redo(); refresh(); }}>Redo</button>
      <button type="button" disabled={(version(), !props.controller.dirty)} onClick={() => void props.controller.save().then(refresh).catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)))}>Save project</button>
    </div></Show>
    <p role={message() ? "alert" : undefined}>{message()}</p>
  </section>;
}
