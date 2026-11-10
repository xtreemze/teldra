/** Decorative SolidJS glyph renderer. Semantic meaning remains with the host control. */
import type { JSX } from "solid-js";
import { studioIconPaths, type StudioIconName } from "./StudioIconCatalog";
import "./StudioIcon.css";
export { studioIconGroups, studioIconNames, studioIconPaths } from "./StudioIconCatalog";
export type { StudioIconName } from "./StudioIconCatalog";

export interface StudioIconProps {
  readonly name: StudioIconName;
  readonly size?: number | string;
  readonly strokeWidth?: number;
  readonly class?: string;
  readonly style?: JSX.CSSProperties;
}

/** A single decorative icon primitive. Never conveys meaning without a text/ARIA label. */
export function StudioIcon(props: StudioIconProps) {
  return <svg
    class={props.class ?? "teldra-studio-icon"}
    style={props.style}
    width={props.size ?? 20}
    height={props.size ?? 20}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={props.strokeWidth ?? 1.8}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  ><path d={studioIconPaths[props.name]} /></svg>;
}

