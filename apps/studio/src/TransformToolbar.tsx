import { For, Show } from "solid-js";
import { StudioIcon } from "./StudioIcon";

export type TransformToolbarMode = "translate" | "rotate" | "scale";

export interface TransformUnavailable {
  /** Why this selection cannot be transformed, in user language. */
  readonly reason: string;
  /** What the user can do instead. */
  readonly workaround: string;
}

export interface TransformToolbarProps {
  /** Name of the selected object. */
  readonly selectionLabel: string;
  /** Present when the selection cannot be transformed; tools are then disabled and explained. */
  readonly unavailable?: TransformUnavailable | undefined;
  /** The active edit mode while a transform session is open; null/undefined before one starts. */
  readonly activeMode?: TransformToolbarMode | null | undefined;
  /** False while the 3D scene is still loading. */
  readonly ready?: boolean | undefined;
  /** Scale eligibility is only known once an IFC session is open. */
  readonly scale?: { readonly supported: boolean; readonly reason?: string } | undefined;
  readonly onSelectMode: (mode: TransformToolbarMode) => void;
}

const TOOLS: ReadonlyArray<{ mode: TransformToolbarMode; label: string; icon: "move" | "rotate" | "scale"; key: string; hint: string }> = [
  { mode: "translate", label: "Move", icon: "move", key: "G", hint: "Move with the 3D gizmo or exact IFC-world coordinates" },
  { mode: "rotate", label: "Rotate", icon: "rotate", key: "R", hint: "Rotate around the vertical axis" },
  { mode: "scale", label: "Scale", icon: "scale", key: "S", hint: "Scale local IFC geometry when the IFC allows it" },
];

/** Persistent contextual Move/Rotate/Scale tools. Presentational: it issues no commands itself. */
export function TransformToolbar(props: TransformToolbarProps) {
  const blocked = () => props.unavailable !== undefined;
  const disabled = (mode: TransformToolbarMode) =>
    blocked() || props.ready === false || (mode === "scale" && props.scale?.supported === false);
  const title = (tool: (typeof TOOLS)[number]) => {
    if (props.unavailable) return props.unavailable.reason;
    if (props.ready === false) return "3D scene is still loading";
    if (tool.mode === "scale" && props.scale?.supported === false) return props.scale.reason ?? "Scale is not available";
    return `${tool.hint} (${tool.key})`;
  };
  return (
    <div class="teldra-transform-toolbar" data-unavailable={blocked() ? "true" : undefined}>
      <div role="toolbar" aria-label="Transform tools" aria-describedby={blocked() ? "teldra-transform-unavailable" : undefined}>
        <span class="teldra-transform-toolbar__target">{props.selectionLabel}</span>
        <For each={TOOLS}>{tool =>
          <button type="button" aria-keyshortcuts={tool.key} title={title(tool)} disabled={disabled(tool.mode)}
            aria-pressed={props.activeMode === tool.mode} onClick={() => props.onSelectMode(tool.mode)}>
            <StudioIcon name={tool.icon} /> {tool.label}
          </button>}
        </For>
      </div>
      <Show when={props.unavailable}>{info =>
        <p id="teldra-transform-unavailable" class="teldra-transform-toolbar__reason" role="status" data-testid="transform-unavailable-reason">
          {info().reason} <strong>Workaround:</strong> {info().workaround}
        </p>}
      </Show>
    </div>
  );
}
