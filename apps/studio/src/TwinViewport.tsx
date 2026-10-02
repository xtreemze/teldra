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

export interface TwinViewportProps {
  readonly manifest: unknown;
  readonly glbUrl: string;
  readonly onSelect?: (identity: TwinRenderIdentity | null) => void;
}

export function TwinViewport(props: TwinViewportProps) {
  let canvas!: HTMLCanvasElement;
  let runtime: BabylonTwinRuntime | undefined;

  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading");
  const [backend, setBackend] = createSignal<BabylonBackend | null>(null);
  const [selected, setSelected] = createSignal<TwinRenderIdentity | null>(null);

  const resize = () => runtime?.resize();

  onMount(() => {
    window.addEventListener("resize", resize);

    void (async () => {
      try {
        runtime = await createBabylonTwinRuntime(canvas, props.manifest);
        setBackend(runtime.backend);
        await runtime.load(props.glbUrl);
        runtime.start();
        setStatus("ready");
      } catch (error) {
        console.error("Failed to initialize Teldra twin viewport.", error);
        setStatus("error");
      }
    })();
  });

  onCleanup(() => {
    window.removeEventListener("resize", resize);
    runtime?.dispose();
  });

  const selectAtPointer = (event: MouseEvent) => {
    if (runtime === undefined || status() !== "ready") {
      return;
    }

    const identity = runtime.pick(event.clientX, event.clientY);
    setSelected(identity);
    props.onSelect?.(identity);
  };

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
        onClick={selectAtPointer}
      />
      <div class="teldra-twin-viewport__status" aria-live="polite">
        <span data-testid="viewport-status">{status()}</span>
        <span data-testid="viewport-backend">{backend() ?? "pending"}</span>
        <span data-testid="selected-canonical-id">
          {selected()?.canonicalId ?? "none"}
        </span>
      </div>
    </section>
  );
}
