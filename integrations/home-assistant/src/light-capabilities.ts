import type { HomeAssistantState } from "./index.js";

export type HaColorMode =
  | "onoff"
  | "brightness"
  | "color_temp"
  | "hs"
  | "xy"
  | "rgb"
  | "rgbw"
  | "rgbww"
  | "white"
  | "unknown";

export interface HaLightCapabilities {
  readonly supportedColorModes: readonly HaColorMode[];
  readonly colorMode: HaColorMode | null;
  readonly brightness: boolean;
  readonly colorTemp: { readonly minKelvin: number; readonly maxKelvin: number } | null;
  readonly rgb: boolean;
  readonly effects: readonly string[];
  readonly transition: boolean;
}

/** Home Assistant LightEntityFeature.TRANSITION bit flag. */
const FEATURE_TRANSITION = 32;

/** Home Assistant's own fallback bounds when a color_temp light reports none. */
const DEFAULT_MIN_KELVIN = 2000;
const DEFAULT_MAX_KELVIN = 6535;

const KNOWN_MODES: ReadonlySet<string> = new Set<HaColorMode>([
  "onoff", "brightness", "color_temp", "hs", "xy", "rgb", "rgbw", "rgbww", "white", "unknown",
]);
const COLOR_MODES: ReadonlySet<HaColorMode> = new Set(["hs", "xy", "rgb", "rgbw", "rgbww"]);

export const NO_LIGHT_CAPABILITIES: HaLightCapabilities = {
  supportedColorModes: ["onoff"],
  colorMode: null,
  brightness: false,
  colorTemp: null,
  rgb: false,
  effects: [],
  transition: false,
};

export function detectLightCapabilities(state: HomeAssistantState): HaLightCapabilities {
  const attrs = state.attributes;
  const reported = Array.isArray(attrs["supported_color_modes"])
    ? attrs["supported_color_modes"].filter(
        (mode): mode is HaColorMode => typeof mode === "string" && KNOWN_MODES.has(mode),
      )
    : [];
  const supportedColorModes: readonly HaColorMode[] =
    reported.length > 0 ? reported : ["onoff"];

  const rawMode = attrs["color_mode"];
  const colorMode =
    typeof rawMode === "string" && KNOWN_MODES.has(rawMode) ? (rawMode as HaColorMode) : null;

  const features = typeof attrs["supported_features"] === "number" ? attrs["supported_features"] : 0;
  const effectList = Array.isArray(attrs["effect_list"])
    ? attrs["effect_list"].filter((e): e is string => typeof e === "string")
    : [];

  return {
    supportedColorModes,
    colorMode,
    brightness: supportedColorModes.some((mode) => mode !== "onoff"),
    colorTemp: supportedColorModes.includes("color_temp")
      ? {
          minKelvin: finiteNumber(attrs["min_color_temp_kelvin"]) ?? DEFAULT_MIN_KELVIN,
          maxKelvin: finiteNumber(attrs["max_color_temp_kelvin"]) ?? DEFAULT_MAX_KELVIN,
        }
      : null,
    rgb: supportedColorModes.some((mode) => COLOR_MODES.has(mode)),
    effects: effectList,
    transition: (features & FEATURE_TRANSITION) !== 0,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------- requests

export type HaLightRequest =
  | { readonly kind: "turn_off"; readonly transitionSeconds?: number }
  | {
      readonly kind: "turn_on";
      readonly brightnessPct?: number;
      readonly colorTempKelvin?: number;
      readonly rgbColor?: readonly [number, number, number];
      readonly effect?: string;
      readonly transitionSeconds?: number;
    };

export type HaLightRequestErrorCode =
  | "unavailable"
  | "unknown-entity"
  | "invalid-value"
  | "use-turn-off"
  | "unsupported-brightness"
  | "unsupported-color-temp"
  | "unsupported-rgb"
  | "conflicting-color"
  | "unknown-effect";

export interface HaRequestAdjustment {
  readonly field: string;
  readonly requested: number | string;
  /** `null` means the field was dropped. */
  readonly applied: number | string | null;
  readonly reason: string;
}

export type HaLightValidation =
  | {
      readonly ok: true;
      readonly service: "turn_on" | "turn_off";
      readonly serviceData: Readonly<Record<string, unknown>>;
      readonly adjustments: readonly HaRequestAdjustment[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: HaLightRequestErrorCode;
        readonly field?: string;
        readonly message: string;
      };
    };

const MAX_TRANSITION_SECONDS = 300;

export interface ValidatableLight {
  readonly available: boolean;
  readonly disabled: boolean;
  readonly capabilities: HaLightCapabilities;
}

/**
 * Validate and clamp an outgoing request against detected capabilities.
 *
 * Unsupported features are rejected rather than silently dropped (so a caller
 * never believes it set a color the light cannot show). Out-of-range values are
 * clamped and reported. Transition is advisory and dropped when unsupported.
 */
export function validateLightRequest(
  light: ValidatableLight,
  request: HaLightRequest,
): HaLightValidation {
  const reject = (
    code: HaLightRequestErrorCode,
    message: string,
    field?: string,
  ): HaLightValidation => ({
    ok: false,
    error: field === undefined ? { code, message } : { code, message, field },
  });

  if (!light.available || light.disabled) {
    return reject("unavailable", "The light is unavailable or disabled.");
  }

  const caps = light.capabilities;
  const data: Record<string, unknown> = {};
  const adjustments: HaRequestAdjustment[] = [];

  const numeric: Array<[string, number | undefined]> = [
    ["transitionSeconds", request.transitionSeconds],
  ];
  if (request.kind === "turn_on") {
    numeric.push(["brightnessPct", request.brightnessPct]);
    numeric.push(["colorTempKelvin", request.colorTempKelvin]);
    request.rgbColor?.forEach((v, i) => numeric.push([`rgbColor[${i}]`, v]));
  }
  for (const [field, value] of numeric) {
    if (value !== undefined && !Number.isFinite(value)) {
      return reject("invalid-value", `${field} must be a finite number.`, field);
    }
  }

  if (request.transitionSeconds !== undefined) {
    if (!caps.transition) {
      adjustments.push({
        field: "transitionSeconds",
        requested: request.transitionSeconds,
        applied: null,
        reason: "The light does not support transitions.",
      });
    } else {
      const applied = clamp(request.transitionSeconds, 0, MAX_TRANSITION_SECONDS);
      data["transition"] = applied;
      if (applied !== request.transitionSeconds) {
        adjustments.push({
          field: "transitionSeconds",
          requested: request.transitionSeconds,
          applied,
          reason: `Clamped to 0..${MAX_TRANSITION_SECONDS} seconds.`,
        });
      }
    }
  }

  if (request.kind === "turn_off") {
    return { ok: true, service: "turn_off", serviceData: data, adjustments };
  }

  if (request.brightnessPct !== undefined) {
    if (request.brightnessPct === 0) {
      return reject("use-turn-off", "Use turn_off instead of brightness 0.", "brightnessPct");
    }
    if (!caps.brightness) {
      return reject("unsupported-brightness", "The light does not support brightness.", "brightnessPct");
    }
    const applied = clamp(Math.round(request.brightnessPct), 1, 100);
    data["brightness_pct"] = applied;
    if (applied !== request.brightnessPct) {
      adjustments.push({
        field: "brightnessPct",
        requested: request.brightnessPct,
        applied,
        reason: "Clamped to 1..100 percent.",
      });
    }
  }

  if (request.colorTempKelvin !== undefined && request.rgbColor !== undefined) {
    return reject("conflicting-color", "Specify either color temperature or RGB, not both.");
  }

  if (request.colorTempKelvin !== undefined) {
    if (caps.colorTemp === null) {
      return reject("unsupported-color-temp", "The light does not support color temperature.", "colorTempKelvin");
    }
    const { minKelvin, maxKelvin } = caps.colorTemp;
    const applied = clamp(Math.round(request.colorTempKelvin), minKelvin, maxKelvin);
    data["color_temp_kelvin"] = applied;
    if (applied !== request.colorTempKelvin) {
      adjustments.push({
        field: "colorTempKelvin",
        requested: request.colorTempKelvin,
        applied,
        reason: `Clamped to ${minKelvin}..${maxKelvin} K.`,
      });
    }
  }

  if (request.rgbColor !== undefined) {
    if (!caps.rgb) {
      return reject("unsupported-rgb", "The light does not support RGB color.", "rgbColor");
    }
    const requested = request.rgbColor;
    const applied = requested.map((channel) => clamp(Math.round(channel), 0, 255));
    data["rgb_color"] = applied;
    if (applied.some((v, i) => v !== requested[i])) {
      adjustments.push({
        field: "rgbColor",
        requested: requested.join(","),
        applied: applied.join(","),
        reason: "Channels rounded/clamped to 0..255.",
      });
    }
  }

  if (request.effect !== undefined) {
    if (!caps.effects.includes(request.effect)) {
      return reject("unknown-effect", `Effect "${request.effect}" is not in the light's effect_list.`, "effect");
    }
    data["effect"] = request.effect;
  }

  return { ok: true, service: "turn_on", serviceData: data, adjustments };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
