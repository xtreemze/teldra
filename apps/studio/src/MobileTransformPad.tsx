import {createEffect, createSignal, onCleanup, Show} from "solid-js";
import type {FurnitureWorldPose} from "@teldra/application";
import {touchTransformPose, type TouchPoint, type TouchTransformMode, type WorldAxis} from "./mobile-transform";
import "./MobileTransformPad.css";

interface MobileTransformPadProps {
  readonly mode: TouchTransformMode;
  readonly pose: () => FurnitureWorldPose;
  readonly translationSnap: number;
  readonly rotationSnap: number; // radians
  readonly onPreview: (pose: FurnitureWorldPose) => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
  readonly startExpanded?: boolean;
}

/**
 * Explicit touch surface: Babylon owns scene navigation and its pointer gizmos;
 * this pad exclusively owns the two-touch transform gesture. No accidental
 * camera-to-IFC conversion and no implicit Apply.
 */
export function MobileTransformPad(props: MobileTransformPadProps) {
  const [axis, setAxis] = createSignal<WorldAxis>("x");
  const [haptics, setHaptics] = createSignal(true);
  const [sound, setSound] = createSignal(false);
  const [label, setLabel] = createSignal("Use two fingers in the touch area to preview a transform.");
  const [announcement, setAnnouncement] = createSignal("");
  const [active, setActive] = createSignal(false);
  const [expanded, setExpanded] = createSignal(props.startExpanded ?? false);
  let audio: AudioContext | undefined;
  let lastCue = 0;
  const contacts = new Map<number, TouchPoint>();
  let gesture: {
    ids: readonly [number, number];
    start: readonly [TouchPoint, TouchPoint];
    base: FurnitureWorldPose;
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
    if (!sound()) return;
    try {
      audio ??= new AudioContext();
      if (audio.state === "suspended") void audio.resume();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.012, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.045);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + 0.05);
    } catch { /* Web Audio is optional, never an editing requirement. */ }
  };

  // Switching tools/axes invalidates a gesture's original coordinate frame.
  createEffect(() => {
    props.mode; axis();
    contacts.clear();
    gesture = null;
    setActive(false);
    setLabel(props.mode === "rotate" ? "Twist two fingers to rotate around IFC world Z." :
      "Slide two fingers vertically to move along world " + axis().toUpperCase() + ".");
  });
  onCleanup(() => { contacts.clear(); gesture = null; if (audio) void audio.close(); });

  const down = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    event.preventDefault();
    contacts.set(event.pointerId, {x: event.clientX, y: event.clientY});
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* Synthetic tests. */ }
    if (contacts.size === 2) {
      const entries = [...contacts.entries()];
      const first = entries[0]!, second = entries[1]!;
      gesture = {ids: [first[0], second[0]], start: [first[1], second[1]],
        base: props.pose(), bucket: 0, lastDelta: 0};
      setActive(true);
      setAnnouncement("Two-finger editing preview active.");
      cue();
    } else if (contacts.size > 2) {
      // A third touch is ambiguous: do not apply any transform until released.
      gesture = null;
      setActive(false);
      setAnnouncement("Use exactly two fingers for this transform.");
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
    if (gesture) {
      props.onPreview(gesture.base);
      gesture = null;
      setAnnouncement("Interrupted gesture reverted to the previous preview.");
    }
    setActive(false);
  };

  return <section class="teldra-mobile-transform-pad" aria-label="Mobile transform gestures">
    <div class="teldra-mobile-transform-pad__header">
      <button type="button" aria-expanded={expanded()} aria-controls="teldra-mobile-transform-details"
        onClick={() => setExpanded(!expanded())}>
        {props.mode === "rotate" ? "Touch rotate" : "Touch move"} {expanded() ? "▴" : "▾"}
      </button>
      <span>{props.mode === "rotate" ? "Two-finger twist" : "Two-finger axis slide"} · Preview</span>
    </div>
    <Show when={expanded()}><div id="teldra-mobile-transform-details" class="teldra-mobile-transform-pad__details">
    <Show when={props.mode === "translate"} fallback={<p class="teldra-mobile-transform-pad__axis-label">World Z rotation only</p>}>
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
    </div></Show>
    <div class="teldra-mobile-transform-pad__actions" role="group" aria-label="Touch transform actions">
      <button type="button" onClick={() => { cue(680); props.onApply(); }}>Apply</button>
      <button type="button" onClick={() => { cue(320); props.onCancel(); }}>Cancel</button>
    </div>
    <Show when={expanded()}><div class="teldra-mobile-transform-pad__feedback">
      <label><input type="checkbox" checked={haptics()} onChange={e => setHaptics(e.currentTarget.checked)} />Haptics</label>
      <label><input type="checkbox" checked={sound()} onChange={e => setSound(e.currentTarget.checked)} />Sound</label>
      <span>Numeric editing remains available in Inspector</span>
    </div></Show>
    <p class="teldra-mobile-transform-pad__announcement" role="status">{announcement()}</p>
  </section>;
}
