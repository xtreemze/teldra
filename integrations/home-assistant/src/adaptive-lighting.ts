import type { HomeAssistantState } from "./index.js";

/**
 * Read-only awareness of the Adaptive Lighting custom integration.
 *
 * Teldra never creates, edits, or toggles these switches. It only observes
 * them so the UI can warn that an automation may override a Teldra command.
 */
export interface AdaptiveLightingInstance {
  readonly switchEntityId: string;
  readonly enabled: boolean;
  readonly lightEntityIds: readonly string[];
  readonly manualControlEntityIds: readonly string[];
  /** "unknown" when the switch does not expose which lights it manages. */
  readonly coverage: "known" | "unknown";
}

export interface LightAdaptiveLightingInfo {
  readonly mayBeOverridden: boolean;
  readonly switchEntityIds: readonly string[];
  /** Adaptive Lighting has currently backed off for this light after a manual change. */
  readonly manualControlActive: boolean;
}

const MAIN_PREFIX = "switch.adaptive_lighting_";
const COMPANION_PREFIXES = [
  "switch.adaptive_lighting_sleep_mode_",
  "switch.adaptive_lighting_adapt_brightness_",
  "switch.adaptive_lighting_adapt_color_",
] as const;

export function isAdaptiveLightingMainSwitch(entityId: string): boolean {
  return (
    entityId.startsWith(MAIN_PREFIX) &&
    !COMPANION_PREFIXES.some((prefix) => entityId.startsWith(prefix))
  );
}

export function detectAdaptiveLightingInstances(
  states: readonly HomeAssistantState[],
): readonly AdaptiveLightingInstance[] {
  return states
    .filter((state) => isAdaptiveLightingMainSwitch(state.entity_id))
    .map((state): AdaptiveLightingInstance => {
      const configuration = state.attributes["configuration"];
      const configLights =
        typeof configuration === "object" && configuration !== null
          ? (configuration as Record<string, unknown>)["lights"]
          : undefined;
      const lights = stringList(configLights) ?? stringList(state.attributes["lights"]);
      return {
        switchEntityId: state.entity_id,
        enabled: state.state === "on",
        lightEntityIds: lights ?? [],
        manualControlEntityIds: stringList(state.attributes["manual_control"]) ?? [],
        coverage: lights === undefined ? "unknown" : "known",
      };
    })
    .sort((a, b) => a.switchEntityId.localeCompare(b.switchEntityId));
}

export function adaptiveLightingInfoForLight(
  entityId: string,
  instances: readonly AdaptiveLightingInstance[],
): LightAdaptiveLightingInfo {
  const relevant = instances.filter(
    (instance) =>
      instance.enabled &&
      (instance.coverage === "unknown" || instance.lightEntityIds.includes(entityId)),
  );
  return {
    mayBeOverridden: relevant.length > 0,
    switchEntityIds: relevant.map((instance) => instance.switchEntityId),
    manualControlActive: relevant.some((instance) =>
      instance.manualControlEntityIds.includes(entityId),
    ),
  };
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}
