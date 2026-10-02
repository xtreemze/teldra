import {
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  createBabylonTwinRuntime,
  type BabylonBackend,
  type BabylonTwinRuntime,
  type TwinRenderIdentity,
} from "@teldra/runtime-babylon";
import "./TwinViewport.css";

export interface TwinViewportClientPoint {
  readonly clientX: number;
  readonly clientY: number;
}

export interface TwinViewportHandle {
  projectNode(nodeKey: string): TwinViewportClientPoint | null;
}

export interface TwinViewportProps {
  readonly manifest: unknown;
  readonly glbUrl: string;
  readonly onReady?: (handle: TwinViewportHandle) => void;
  readonly onSelect?: (identity: TwinRenderIdentity | null) => void;
}

export function TwinViewport(props: TwinViewportProps) {
  let canvas!: HTMLCanvasElement;
  let runtime: BabylonTwinRuntime | undefined;
  let unsubscribePick: (() => void) | undefined;

  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading");
  const [backend, setBackend] = createSignal<BabylonBackend | null>(null);
  const [selected, setSelected] =
    createSignal<TwinRenderIdentity | null | undefined>(undefined);

  const resize = () => runtime?.resize();

  onMount(() => {
    window.addEventListener("resize", resize);

    void (async () => {
      try {
        runtime = await createBabylonTwinRuntime(canvas, props.manifest);
        runtime.resize();
        setBackend(runtime.backend);
        unsubscribePick = runtime.onPick((identity) => {
          setSelected(identity);
          props.onSelect?.(identity);
        });
        await runtime.load(props.glbUrl);
        runtime.start();

        const readyRuntime = runtime;
        props.onReady?.({
          projectNode(nodeKey) {
            return readyRuntime.projectNode(nodeKey);
          },
        });

        setStatus("ready");
      } catch (error) {
        console.error("Failed to initialize Teldra twin viewport.", error);
        setStatus("error");
      }
    })();
  });

  onCleanup(() => {
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
        data-testid="twin-canvas"
      />
      <div class="teldra-twin-viewport__status" aria-live="polite">
        <span data-testid="viewport-status">{status()}</span>
        <span data-testid="viewport-backend">{backend() ?? "pending"}</span>
        <span data-testid="selected-canonical-id">
          {selected() === undefined
            ? "unattempted"
            : selected()?.canonicalId ?? "none"}
        </span>
      </div>
    </section>
  );
}
