import type { FurnitureGeometryScale, FurnitureWorldPose } from "@teldra/application";

/**
 * Blender-inspired modal shortcuts, limited to Teldra's validated IFC4 furniture
 * placement capabilities. This reducer owns *interaction state only*: no IFC
 * bytes, Babylon meshes or project state are mutated here.
 */
export type SupportedTransform = "translate" | "rotate" | "scale";
export type TransformAxis = "x" | "y" | "z";
export interface TransformModal {
  readonly mode: SupportedTransform;
  readonly axis: TransformAxis | null;
  readonly numeric: string;
}
export interface TransformKey {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}
export type TransformIntent = "begin" | "preview" | "confirm" | "cancel" | "unsupported" | "message";
export interface TransformStep {
  readonly handled: boolean;
  readonly state: TransformModal | null;
  readonly intent?: TransformIntent;
  readonly message?: string;
}

const INVALID_SCALE =
  "Scale (S) is not available for this IFC object. Scaling requires a validated IFC representation or instance-dimension command; a visual mesh scale cannot be saved as BIM geometry.";

export function transformShortcut(state: TransformModal | null, input: TransformKey, allowScale = false): TransformStep {
  const key = input.key.toLowerCase();
  const ignored: TransformStep = { handled: false, state };
  if (input.altKey || input.ctrlKey || input.metaKey) return ignored;
  if (key === "s" && !allowScale) return { handled: true, state, intent: "unsupported", message: INVALID_SCALE };
  if (key === "g" || key === "r" || key === "s") {
    const mode = key === "g" ? "translate" : key === "r" ? "rotate" : "scale";
    return { handled: true, state: {mode, axis: null, numeric: ""}, intent: "begin" };
  }
  if (state === null) return ignored;
  if (key === "escape") return { handled: true, state: null, intent: "cancel" };
  if (key === "enter" || key === "numpadenter") {
    if (state.numeric !== "" && !Number.isFinite(Number(state.numeric))) {
      return { handled: true, state, intent: "message", message: "Enter a finite numeric transform amount." };
    }
    if (state.mode === "scale" && state.numeric !== "" && (Number(state.numeric) <= 0 || Number(state.numeric) > 1000)) {
      return { handled: true, state, intent: "message", message: "Scale factor must be positive and at most 1000." };
    }
    if (state.mode === "translate" && state.numeric !== "" && state.axis === null) {
      return { handled: true, state, intent: "message", message: "Choose X, Y or Z before entering a numeric move." };
    }
    return { handled: true, state: null, intent: "confirm" };
  }
  if (key === "x" || key === "y" || key === "z") {
    if (state.mode === "rotate" && key !== "z") {
      return { handled: true, state, intent: "message", message: "IFC4 upright furniture can only rotate around world Z." };
    }
    return { handled: true, state: {...state, axis: state.axis === key ? null : key}, intent: "preview" };
  }
  if (key === "backspace") {
    return { handled: true, state: {...state, numeric: state.numeric.slice(0, -1)}, intent: "preview" };
  }
  // Numpad key strings are digits as well; do not interpret locale commas.
  const candidate = /^[0-9]$/.test(key) ? state.numeric + key
    : key === "." || key === "decimal" ? state.numeric + "."
    : key === "-" || key === "subtract" ? (state.numeric.startsWith("-") ? state.numeric.slice(1) : "-" + state.numeric)
    : null;
  if (candidate === null) return ignored;
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d*)?$/.test(candidate) || candidate.length > 20) {
    return { handled: true, state, intent: "message", message: "Enter a valid decimal value." };
  }
  return { handled: true, state: {...state, numeric: candidate}, intent: "preview" };
}

/**
 * A numeric entry is a delta from the captured pose. Move demands an axis.
 * Upright IFC furniture rotates about Z; nonuniform scaling is not represented
 * by a furniture placement and is deliberately not synthesized.
 */
export function numericFurniturePose(base: FurnitureWorldPose, state: TransformModal): FurnitureWorldPose | null {
  if (!state.numeric || !Number.isFinite(Number(state.numeric))) return null;
  const amount = Number(state.numeric);
  if (state.mode === "scale") return null;
  if (state.mode === "rotate") return {
    position: [...base.position] as [number, number, number],
    yawRadians: base.yawRadians + amount * Math.PI / 180,
  };
  if (!state.axis) return null;
  const position: [number, number, number] = [...base.position];
  const index = {x: 0, y: 1, z: 2}[state.axis];
  position[index] = position[index]! + amount;
  return { position, yawRadians: base.yawRadians };
}


/** Local-axis scale delta, not object-mode pose scaling. The baseline is never modified. */
export function numericFurnitureScale(base: FurnitureGeometryScale, state: TransformModal): FurnitureGeometryScale | null {
  if (state.mode !== "scale" || !state.numeric || !Number.isFinite(Number(state.numeric))) return null;
  const factor = Number(state.numeric);
  if (factor <= 0 || factor > 1000) return null;
  const result: [number, number, number] = [...base];
  if (state.axis === null) for (let i = 0; i < 3; i++) result[i] = result[i]! * factor;
  else {
    const index = {x: 0, y: 1, z: 2}[state.axis];
    result[index] = result[index]! * factor;
  }
  return result.every(value => Number.isFinite(value) && value > 0 && value <= 1000) ? result : null;
}
