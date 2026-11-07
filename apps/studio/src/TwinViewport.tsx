import {
  createEffect,
  createSignal,
  Show,
  onCleanup,
  onMount,
} from "solid-js";
import type {
  BabylonBackend,
  BabylonTwinRuntime,
  TwinRenderIdentity,
} from "@teldra/runtime-babylon";
import "./TwinViewport.css";
import { ViewportControls } from "./ViewportControls";
import { CanvasGestureArbiter, type CanvasGestureIntent } from "./viewport-touch-gestures";

export interface TwinViewportClientPoint {
  readonly clientX: number;
  readonly clientY: number;
}

export interface TwinViewportHandle {
  layers(): ReturnType<BabylonTwinRuntime["layers"]>;
  viewState(): ReturnType<BabylonTwinRuntime["viewState"]>;
  fitHome(): boolean;
  assetSummary(): ReturnType<BabylonTwinRuntime["assetSummary"]>;
  renderStats(): ReturnType<BabylonTwinRuntime["renderStats"]>;
  batchingStats(): ReturnType<BabylonTwinRuntime["batchingStats"]>;
  applyScenePlacements: BabylonTwinRuntime["applyScenePlacements"];
  measureFurnitureGeometry: BabylonTwinRuntime["measureFurnitureGeometry"];
  assertFurnitureAffineProjectable: BabylonTwinRuntime["assertFurnitureAffineProjectable"];
  beginFurnitureEdit: BabylonTwinRuntime["beginFurnitureEdit"];
  projectNode(nodeKey: string): TwinViewportClientPoint | null;
  pick(clientX: number, clientY: number): TwinRenderIdentity | null;
}

export interface TwinViewportProps {
  readonly selectedCanonicalId?: string | null | undefined;
  readonly batchOpaqueParts?: boolean | undefined;
  readonly manifest: unknown;
  readonly glbUrl: string;
  readonly onReady?: (handle: TwinViewportHandle) => void;
  readonly onSelect?: (identity: TwinRenderIdentity | null) => void;
  /** Optional mobile-only, non-IFC canvas gesture intents; handlers own undo/redo gating. */
  readonly onTouchGesture?: (kind: "menu" | "undo" | "redo" | "frame", identity?: TwinRenderIdentity) => void;
  readonly gesturesDisabled?: boolean;
}

export function TwinViewport(props: TwinViewportProps) {
  let canvas!: HTMLCanvasElement;
  let runtime: BabylonTwinRuntime | undefined;
  let unsubscribePick: (() => void) | undefined;
  let disposed = false;

  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading");
  const [readyRuntime, setReadyRuntime] = createSignal<BabylonTwinRuntime>();
  const [backend, setBackend] = createSignal<BabylonBackend | null>(null);
  const [assetSummary, setAssetSummary] = createSignal<ReturnType<BabylonTwinRuntime["assetSummary"]>>();
  const [hasHiddenSourceContent, setHasHiddenSourceContent] = createSignal(false);
  const [selected, setSelected] =
    createSignal<TwinRenderIdentity | null | undefined>(undefined);

  const resize = () => runtime?.resize();

  createEffect(() => {
    const current = readyRuntime();
    const id = props.selectedCanonicalId === undefined
      ? selected()?.canonicalId ?? null
      : props.selectedCanonicalId;
    current?.setSelection(id);
  });


  onMount(() => {
    window.addEventListener("resize", resize);

    // One arbiter for all canvas touches. Babylon owns one/two-finger camera
    // navigation; three-finger move events are isolated from its pointer input.
    // Capture-phase click suppression runs ahead of runtime.onPick().
    const gestures = new CanvasGestureArbiter();
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    const enabled = () => !props.gesturesDisabled &&
      window.matchMedia("(max-width: 48rem)").matches;
    const clearHold = () => {
      if (holdTimer !== undefined) clearTimeout(holdTimer);
      holdTimer = undefined;
    };
    const handleIntent = (intent: CanvasGestureIntent | null) => {
      if (!intent || !runtime || !enabled()) return;
      if (!("x" in intent)) {
        props.onTouchGesture?.(intent.type);
        return;
      }
      const picked = runtime.pick(intent.x, intent.y);
      if (!picked) return;
      if (intent.type === "longpress") {
        props.onTouchGesture?.("menu", picked);
      } else {
        // Explicit null means the owner cleared selection. Only undefined
        // opts into the viewport's internal selection fallback.
        const selectedId = props.selectedCanonicalId === undefined
          ? selected()?.canonicalId ?? null : props.selectedCanonicalId;
        if (picked.canonicalId === selectedId && runtime.fit(picked.canonicalId))
          props.onTouchGesture?.("frame", picked);
      }
    };
    const touchPoint = (event: PointerEvent) => ({
      pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      time: performance.now(), pointerType: event.pointerType === "pen" ? "pen" as const : "touch" as const,
    });
    const onDown = (event: PointerEvent) => {
      if (!["touch", "pen"].includes(event.pointerType) || !enabled() || event.target !== canvas) return;
      gestures.down(touchPoint(event));
      clearHold();
      if (gestures.activeContacts === 1) {
        holdTimer = setTimeout(() => {
          holdTimer = undefined;
          handleIntent(gestures.hold(performance.now()));
        }, 500);
      }
    };
    const onMove = (event: PointerEvent) => {
      if (!["touch", "pen"].includes(event.pointerType) || !gestures.activeContacts) return;
      const result = gestures.move(touchPoint(event));
      if (result.cancelHold) clearHold();
      if (result.blockCamera) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const onUp = (event: PointerEvent) => {
      if (!["touch", "pen"].includes(event.pointerType) || !gestures.activeContacts) return;
      const intent = gestures.up(touchPoint(event));
      clearHold();
      handleIntent(intent);
    };
    const onCancel = (event: PointerEvent) => {
      if (!["touch", "pen"].includes(event.pointerType)) return;
      gestures.abort(performance.now());
      clearHold();
    };
    const reset = () => { gestures.abort(performance.now()); clearHold(); };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") reset();
    };
    const onClickCapture = (event: MouseEvent) => {
      if (!gestures.suppressClick(performance.now())) return;
      // Modern browsers dispatch PointerEvent clicks with a pointerType.
      // Do not swallow an actual mouse click following a touch interaction.
      if (event instanceof PointerEvent && event.pointerType === "mouse") return;
      // Keyboard/assistive-tech activations have no click count, unlike
      // compatibility clicks synthesized after a touch or stylus gesture.
      if (event.detail === 0 && !(event instanceof PointerEvent)) return;
      const source = (event as MouseEvent & {
        sourceCapabilities?: {firesTouchEvents?: boolean}
      }).sourceCapabilities;
      if (source?.firesTouchEvents === false) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("blur", reset);
    window.addEventListener("resize", reset);
    document.addEventListener("visibilitychange", onVisibilityChange);
    canvas.addEventListener("click", onClickCapture, true);
    onCleanup(() => {
      clearHold();
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", reset);
      window.removeEventListener("resize", reset);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.removeEventListener("click", onClickCapture, true);
    });

    void (async () => {
      try {
        const { createBabylonTwinRuntime } = await import("@teldra/runtime-babylon");
        if (disposed) return;
        const params = new URLSearchParams(window.location.search);
        const depth = params.get("depth");
        const depthMode = depth === "standard" || depth === "reverse" ? depth : "auto";
        const created = await createBabylonTwinRuntime(canvas, props.manifest, {
          batchOpaqueParts: props.batchOpaqueParts ?? true,
          forceWebGL: params.get("renderer") === "webgl",
          depthMode,
        });
        if (disposed) {
          created.dispose();
          return;
        }
        runtime = created;
        runtime.resize();
        setBackend(runtime.backend);
        unsubscribePick = runtime.onPick((identity) => {
          setSelected(identity);
          props.onSelect?.(identity);
        });
        await runtime.load(props.glbUrl);
        if (disposed) return;
        if (runtime.assetSummary().sourcePhongMaterials > 0) {
          runtime.setLayerVisible("category:Ground and background", false);
          runtime.orient("isometric"); runtime.orbit(Math.PI, 0); runtime.fitHome();
        }
        setAssetSummary(runtime.assetSummary());
        runtime.start();
        setReadyRuntime(runtime);
        setHasHiddenSourceContent(runtime.assetSummary().hiddenSourceParts > 0);

        const readyRuntime = runtime;
        props.onReady?.({
          fitHome: () => readyRuntime.fitHome(),
          layers: () => readyRuntime.layers(),
          viewState: () => readyRuntime.viewState(),
          assetSummary: () => readyRuntime.assetSummary(),
          renderStats: () => readyRuntime.renderStats(),
          batchingStats: () => readyRuntime.batchingStats(),
          applyScenePlacements: (placements) => readyRuntime.applyScenePlacements(placements),
          measureFurnitureGeometry: (canonicalId, original) => readyRuntime.measureFurnitureGeometry(canonicalId, original),
          assertFurnitureAffineProjectable: (canonicalId, delta) => readyRuntime.assertFurnitureAffineProjectable(canonicalId, delta),
          beginFurnitureEdit: (placement, onPreview, onDragState, onScalePreview) => readyRuntime.beginFurnitureEdit(placement, onPreview, onDragState, onScalePreview),
          projectNode(nodeKey) {
            return readyRuntime.projectNode(nodeKey);
          },
          pick(clientX, clientY) {
            return readyRuntime.pick(clientX, clientY);
          },
        });

        setStatus("ready");
      } catch (error) {
        if (disposed) return;
        console.error("Failed to initialize Teldra twin viewport.", error);
        setStatus("error");
      }
    })();
  });

  onCleanup(() => {
    disposed = true;
    window.removeEventListener("resize", resize);
    unsubscribePick?.();
    runtime?.dispose();
  });

  return (
    <section
      class="teldra-twin-viewport"
      aria-label="Smart home twin viewport"
      data-status={status()}
      data-backend={backend() ?? ""}
      data-depth-mode={readyRuntime() ? (readyRuntime()!.renderStats().reverseDepth ? "reverse" : "standard") : ""}
    >
      <canvas
        ref={canvas}
        class="teldra-twin-viewport__canvas"
        width="640"
        height="400"
        tabindex="0"
        aria-label="3D scene navigation"
        data-testid="twin-canvas"
      />
      <Show when={status() === "loading"}><div class="teldra-twin-viewport__loading" role="status">Preparing materials and textures...</div></Show>
      <output data-testid="asset-summary" hidden>{JSON.stringify(assetSummary())}</output>
      <Show when={readyRuntime()}>{current => <ViewportControls runtime={current()} canvas={canvas} selectedId={props.selectedCanonicalId === undefined ? selected()?.canonicalId : props.selectedCanonicalId ?? undefined} />}</Show>
      <div class="teldra-twin-viewport__status" aria-live="polite">
        <span data-testid="viewport-status">{status()}</span>
        <span data-testid="viewport-backend">{backend() ?? "pending"}</span>
        <span data-testid="selected-canonical-id">
          {selected() === undefined
            ? "unattempted"
            : selected()?.canonicalId ?? "none"}
        </span>
      </div>
      {hasHiddenSourceContent() && (
        <label>
          <input type="checkbox" onChange={event =>
            runtime?.setHiddenSourceContentVisible(event.currentTarget.checked)} />
          Show hidden source content
        </label>
      )}
    </section>
  );
}
