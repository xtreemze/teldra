import type { HomeAssistantState } from "./index.js";
import {
  adaptiveLightingInfoForLight,
  detectAdaptiveLightingInstances,
  type AdaptiveLightingInstance,
  type LightAdaptiveLightingInfo,
} from "./adaptive-lighting.js";
import {
  NO_LIGHT_CAPABILITIES,
  detectLightCapabilities,
  type HaLightCapabilities,
} from "./light-capabilities.js";

// Raw shapes returned by Home Assistant's WebSocket registry commands. Only the
// fields Teldra reads are listed; extra fields are ignored.
export interface HaAreaRegistryEntry {
  readonly area_id: string;
  readonly name: string;
}

export interface HaDeviceRegistryEntry {
  readonly id: string;
  readonly name?: string | null;
  readonly name_by_user?: string | null;
  readonly area_id?: string | null;
}

export interface HaEntityRegistryEntry {
  readonly entity_id: string;
  readonly device_id?: string | null;
  readonly area_id?: string | null;
  readonly platform?: string;
  readonly name?: string | null;
  readonly original_name?: string | null;
  readonly disabled_by?: string | null;
  readonly hidden_by?: string | null;
}

export interface HaRawSnapshot {
  readonly areas: readonly HaAreaRegistryEntry[];
  readonly devices: readonly HaDeviceRegistryEntry[];
  readonly entities: readonly HaEntityRegistryEntry[];
  readonly states: readonly HomeAssistantState[];
}

// Normalized, platform-neutral inventory. Home Assistant entity ids appear here
// only as external identifiers; they are never Teldra canonical ids.
export interface HaArea {
  readonly areaId: string;
  readonly name: string;
}

export interface HaLight {
  readonly entityId: string;
  readonly name: string;
  readonly areaId: string | null;
  readonly deviceId: string | null;
  readonly platform: string | null;
  readonly state: string;
  readonly available: boolean;
  readonly disabled: boolean;
  readonly hidden: boolean;
  readonly isGroup: boolean;
  readonly memberEntityIds: readonly string[];
  readonly memberOfGroups: readonly string[];
  readonly capabilities: HaLightCapabilities;
  readonly adaptiveLighting: LightAdaptiveLightingInfo;
}

export interface HaLightGroup {
  readonly entityId: string;
  readonly name: string;
  readonly memberEntityIds: readonly string[];
}

/** Scenes are listed read-only. Teldra exposes no scene-activation surface. */
export interface HaScene {
  readonly entityId: string;
  readonly name: string;
  readonly areaId: string | null;
  readonly memberEntityIds: readonly string[];
}

export interface HaInventory {
  readonly areas: readonly HaArea[];
  readonly lights: readonly HaLight[];
  readonly groups: readonly HaLightGroup[];
  readonly scenes: readonly HaScene[];
  readonly adaptiveLighting: readonly AdaptiveLightingInstance[];
}

export function normalizeInventory(raw: HaRawSnapshot): HaInventory {
  const devices = new Map(raw.devices.map((d) => [d.id, d] as const));
  const registry = new Map(raw.entities.map((e) => [e.entity_id, e] as const));
  const states = new Map(raw.states.map((s) => [s.entity_id, s] as const));
  const adaptive = detectAdaptiveLightingInstances(raw.states);

  const lightIds = new Set<string>();
  const sceneIds = new Set<string>();
  for (const id of [...registry.keys(), ...states.keys()]) {
    if (id.startsWith("light.")) lightIds.add(id);
    if (id.startsWith("scene.")) sceneIds.add(id);
  }

  const areaOf = (entityId: string): string | null => {
    const entry = registry.get(entityId);
    if (entry?.area_id != null) return entry.area_id;
    if (entry?.device_id != null) return devices.get(entry.device_id)?.area_id ?? null;
    return null;
  };

  const memberOf = new Map<string, string[]>();
  const base = [...lightIds].sort().map((entityId) => {
    const state = states.get(entityId);
    const entry = registry.get(entityId);
    const members = entityIdList(state?.attributes["entity_id"]);
    for (const member of members ?? []) {
      memberOf.set(member, [...(memberOf.get(member) ?? []), entityId]);
    }
    return { entityId, state, entry, members };
  });

  const lights: HaLight[] = base.map(({ entityId, state, entry, members }) => {
    const disabled = entry?.disabled_by != null;
    const rawState = state?.state ?? "unavailable";
    return {
      entityId,
      name: friendlyName(state) ?? entry?.name ?? entry?.original_name ?? entityId,
      areaId: areaOf(entityId),
      deviceId: entry?.device_id ?? null,
      platform: entry?.platform ?? null,
      state: rawState,
      available: !disabled && state !== undefined && rawState !== "unavailable",
      disabled,
      hidden: entry?.hidden_by != null,
      isGroup: members !== undefined,
      memberEntityIds: members ?? [],
      memberOfGroups: [...(memberOf.get(entityId) ?? [])].sort(),
      capabilities: state === undefined ? NO_LIGHT_CAPABILITIES : detectLightCapabilities(state),
      adaptiveLighting: adaptiveLightingInfoForLight(entityId, adaptive),
    };
  });

  const scenes: HaScene[] = [...sceneIds].sort().map((entityId) => {
    const state = states.get(entityId);
    return {
      entityId,
      name: friendlyName(state) ?? registry.get(entityId)?.name ?? entityId,
      areaId: areaOf(entityId),
      memberEntityIds: entityIdList(state?.attributes["entity_id"]) ?? [],
    };
  });

  return {
    areas: raw.areas
      .map((a) => ({ areaId: a.area_id, name: a.name }))
      .sort((a, b) => a.areaId.localeCompare(b.areaId)),
    lights,
    groups: lights
      .filter((l) => l.isGroup)
      .map((l) => ({ entityId: l.entityId, name: l.name, memberEntityIds: l.memberEntityIds })),
    scenes,
    adaptiveLighting: adaptive,
  };
}

function friendlyName(state: HomeAssistantState | undefined): string | undefined {
  const name = state?.attributes["friendly_name"];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function entityIdList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}
