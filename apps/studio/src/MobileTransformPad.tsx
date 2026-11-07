import {createEffect, createSignal, onCleanup, Show} from "solid-js";
import type {FurnitureGeometryScale, FurnitureWorldPose} from "@teldra/application";
import {touchTransformPose, touchScalePreview, type ScaleAxis, type TouchPoint, type TouchTransformMode, type WorldAxis} from "./mobile-transform";
import "./MobileTransformPad.css";
import {signalMobileTone} from "./mobile-feedback";

interface MobileTransformPadProps {
  readonly mode: TouchTransformMode;
  readonly pose: () => FurnitureWorldPose;
  readonly scale: () => FurnitureGeometryScale | null;
  readonly translationSnap: number;
  readonly rotationSnap: number; // radians
  readonly onPreview: (pose: FurnitureWorldPose) => void;
  readonly onScalePreview: (scale: FurnitureGeometryScale) => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
  readonly onModeChange?: (mode: TouchTransformMode) => void;
  readonly scaleAvailable?: boolean;
  readonly hapticsEnabled?: boolean;
  readonly onHapticsChange?: (enabled: boolean) => void;
  readonly soundEnabled?: boolean;
  readonly onSoundChange?: (enabled: boolean) => void;
  readonly startExpanded?: boolean;
}

/**
 * Explicit touch surface: Babylon owns scene navigation and its pointer gizmos;
 * this pad exclusively owns the two-touch transform gesture. No accidental
 * camera-to-IFC conversion and no implicit Apply.
 */
export function MobileTransformPad(props: MobileTransformPadProps) {
  const [axis, setAxis] = createSignal<WorldAxis>("x");
  const [scaleAxis, setScaleAxis] = createSignal<ScaleAxis>("all");
  const [localHaptics, setLocalHaptics] = createSignal(true);
  const haptics = () => props.hapticsEnabled ?? localHaptics();
  const [localSound, setLocalSound] = createSignal(false);
  const sound = () => props.soundEnabled ?? localSound();
  const [label, setLabel] = createSignal("Use two fingers in the touch area to preview a transform.");
  const [announcement, setAnnouncement] = createSignal("");
  const [active, setActive] = createSignal(false);
  const [expanded, setExpanded] = createSignal(props.startExpanded ?? false);
  let lastCue = 0;
  const contacts = new Map<number, TouchPoint>();
  let gesture: {
    ids: readonly [number, number];
    start: readonly [TouchPoint, TouchPoint];
    base: FurnitureWorldPose;
    baseScale: FurnitureGeometryScale | null;
    mode: TouchTransformMode;
    bucket: number;
    lastDelta: number;
  } | null = null;

  const cue = (frequency = 490) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const now = performance.now();
    if (now - lastCue < 65) return;
    lastCue = now;
    if (haptics()) {
      try { navigator.vibrate?.(8); } catch { /* Unsupported devices remain silent. */ }
    }
    if (sound()) signalMobileTone(frequency, true);
  };

  // Restore only the in-progress gesture, not an already completed preview:
  // switching axes or tools must never leave a partial IFC draft behind.
  const rollbackActiveGesture = () => {
    const previous = gesture;
    gesture = null;
    if (!previous) return false;
    if (previous.mode === "scale" && previous.baseScale)
      props.onScalePreview(previous.baseScale);
    else
      props.onPreview(previous.base);
    return true;
  };

  // Switching tools/axes invalidates the gesture's original coordinate frame.
  createEffect(() => {
    props.mode; axis(); scaleAxis();
    const wasActive = rollbackActiveGesture();
    contacts.clear();
    setActive(false);
    if (wasActive) setAnnouncement("Gesture interrupted by tool change. Previous draft restored.");
    setLabel(props.mode === "rotate" ? "Twist two fingers to rotate around IFC world Z." :
      props.mode === "scale" ? "Pinch with two fingers to scale validated IFC geometry (" + scaleAxis().toUpperCase() + ")." :
      "Slide two fingers vertically to move along world " + axis().toUpperCase() + ".");
  });
  onCleanup(() => { contacts.clear(); gesture = null; });

  const down = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    event.preventDefault();
    contacts.set(event.pointerId, {x: event.clientX, y: event.clientY});
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* Synthetic tests. */ }
    if (contacts.size === 2) {
      const entries = [...contacts.entries()];
      const first = entries[0]!, second = entries[1]!;
      gesture = {ids: [first[0], second[0]], start: [first[1], second[1]],
        base: props.pose(), baseScale: props.scale(), mode: props.mode,
        bucket: 0, lastDelta: props.mode === "scale" ? 1 : 0};
      setActive(true);
      setAnnouncement("Two-finger editing preview active.");
      cue();
    } else if (contacts.size > 2) {
      // A third touch is ambiguous. Restore the pre-gesture draft, not a
      // partially changed preview, and require every finger to lift first.
      rollbackActiveGesture();
      setActive(false);
      setAnnouncement("Gesture cancelled: use exactly two fingers.");
    }
  };
  const move = (event: PointerEvent) => {
    if (!contacts.has(event.pointerId)) return;
    event.preventDefault();
    contacts.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (!gesture || contacts.size !== 2) return;
    const first = contacts.get(gesture.ids[0]), second = contacts.get(gesture.ids[1]);
    if (!first || !second) return;
    const mode = props.mode;
    if (mode === "scale") {
      if (!gesture.baseScale) return;
      const result = touchScalePreview(gesture.baseScale, gesture.start, [first, second], scaleAxis());
      if (!result || Math.abs(result.ratio - gesture.lastDelta) < 1e-7) return;
      gesture.lastDelta = result.ratio;
      props.onScalePreview(result.scale);
      setLabel("Scale " + scaleAxis().toUpperCase() + ": " + (result.ratio * 100).toFixed(1) + "% of gesture start · preview only");
      const bucket = Math.round((result.ratio - 1) / 0.05);
      if (bucket !== gesture.bucket) { gesture.bucket = bucket; cue(510); }
      return;
    }
    const snap = mode === "rotate" ? props.rotationSnap : props.translationSnap;
    const result = touchTransformPose(gesture.base, gesture.start, [first, second], mode, axis(), snap);
    if (!result || Math.abs(result.delta - gesture.lastDelta) < 1e-7) return;
    gesture.lastDelta = result.delta;
    props.onPreview(result.pose);
    const quantity = mode === "rotate" ? result.delta * 180 / Math.PI : result.delta;
    setLabel((mode === "rotate" ? "Rotation Z: " : "World " + axis().toUpperCase() + ": ") +
      (quantity >= 0 ? "+" : "") + quantity.toFixed(2) + (mode === "rotate" ? "°" : " m") +
      " · preview only");
    const bucketSize = snap > 0 ? snap : (mode === "rotate" ? Math.PI / 12 : 0.1);
    const bucket = Math.round(result.delta / bucketSize);
    if (bucket !== gesture.bucket) { gesture.bucket = bucket; cue(510); }
  };
  const up = (event: PointerEvent) => {
    if (!contacts.has(event.pointerId)) return;
    event.preventDefault();
    contacts.delete(event.pointerId);
    if (gesture && contacts.size < 2) {
      gesture = null;
      setActive(false);
      setAnnouncement("Preview ready. Apply placement to commit, or Cancel to discard.");
      cue(620);
    }
    if (!contacts.size) gesture = null;
  };
  const cancel = (event: PointerEvent) => {
    if (!contacts.has(event.pointerId)) return;
    event.preventDefault();
    contacts.delete(event.pointerId);
    if (rollbackActiveGesture()) {
      setAnnouncement("Interrupted gesture reverted to the previous preview.");
    }
    setActive(false);
  };

  return <section class="teldra-mobile-transform-pad" aria-label="Mobile transform gestures">
    <div class="teldra-mobile-transform-pad__header">
      <button type="button" aria-expanded={expanded()} aria-controls="teldra-mobile-transform-details"
        onClick={() => setExpanded(!expanded())}>
        {props.mode === "rotate" ? "Touch rotate" : props.mode === "scale" ? "Touch scale" : "Touch move"} {expanded() ? "▴" : "▾"}
      </button>
      <span>{props.mode === "rotate" ? "Two-finger twist" : props.mode === "scale" ? "Two-finger pinch" : "Two-finger axis slide"} · Preview</span>
    </div>
    <Show when={props.onModeChange}>
      <div class="teldra-mobile-transform-pad__modes" role="group" aria-label="Touch editing mode">
        {(["translate", "rotate", "scale"] as const).map(mode =>
          <button type="button" aria-pressed={props.mode === mode}
            disabled={mode === "scale" && !props.scaleAvailable}
            title={mode === "scale" && !props.scaleAvailable ? "This furniture has no supported IFC mapped geometry scale" : undefined}
            onClick={() => props.onModeChange?.(mode)}>
            {mode === "translate" ? "Move" : mode === "rotate" ? "Rotate" : "Scale"}
          </button>)}
      </div>
    </Show>
    <div id="teldra-mobile-transform-details" class="teldra-mobile-transform-pad__details" hidden={!expanded()}>
    <Show when={props.mode === "translate"} fallback={
      <Show when={props.mode === "scale"} fallback={<p class="teldra-mobile-transform-pad__axis-label">World Z rotation only</p>}>
        <div class="teldra-mobile-transform-pad__axes" role="group" aria-label="Scale local IFC geometry axis">
          {(["all", "x", "y", "z"] as const).map(value =>
            <button type="button" aria-pressed={scaleAxis() === value}
              onClick={() => setScaleAxis(value)}>{value === "all" ? "All" : value.toUpperCase()}</button>)}
        </div>
      </Show>
    }>
      <div class="teldra-mobile-transform-pad__axes" role="group" aria-label="Move along world axis">
        {(["x", "y", "z"] as const).map(value =>
          <button type="button" aria-pressed={axis() === value}
            onClick={() => setAxis(value)}>{value.toUpperCase()}</button>)}
      </div>
    </Show>
    <div class="teldra-mobile-transform-pad__surface" classList={{"is-active": active()}}
      role="group" aria-label="Two-finger transform touch area"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}>
      <span aria-hidden="true" class="teldra-mobile-transform-pad__contact">◎　◎</span>
      <output data-testid="mobile-transform-delta" aria-live="off">{label()}</output>
    </div>
    </div>
    <div class="teldra-mobile-transform-pad__actions" role="group" aria-label="Touch transform actions">
      <button type="button" onClick={() => { cue(680); props.onApply(); }}>Apply</button>
      <button type="button" onClick={() => { cue(320); props.onCancel(); }}>Cancel</button>
    </div>
    <Show when={expanded()}><div class="teldra-mobile-transform-pad__feedback">
      <label><input type="checkbox" checked={haptics()} onChange={e => { setLocalHaptics(e.currentTarget.checked); props.onHapticsChange?.(e.currentTarget.checked); }} />Haptics</label>
      <label><input type="checkbox" checked={sound()} onChange={e => { setLocalSound(e.currentTarget.checked); props.onSoundChange?.(e.currentTarget.checked); }} />Sound</label>
      <span>Numeric editing remains available in Inspector</span>
    </div></Show>
    <p class="teldra-mobile-transform-pad__announcement" role="status">{announcement()}</p>
  </section>;
}
