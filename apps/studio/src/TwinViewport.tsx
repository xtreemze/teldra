import {
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

  onMount(() => {
    window.addEventListener("resize", resize);

    void (async () => {
      try {
        const { createBabylonTwinRuntime } = await import("@teldra/runtime-babylon");
        if (disposed) return;
        const created = await createBabylonTwinRuntime(canvas, props.manifest, {batchOpaqueParts: props.batchOpaqueParts ?? true});
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
          beginFurnitureEdit: (placement, onPreview, onDragState) => readyRuntime.beginFurnitureEdit(placement, onPreview, onDragState),
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
