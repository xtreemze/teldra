import type { HomeAssistantState } from "./index.js";
import type { HaRawSnapshot } from "./inventory.js";

export interface HaContext {
  readonly id: string;
  readonly parent_id?: string | null;
  readonly user_id?: string | null;
}

export interface HaStateWithContext extends HomeAssistantState {
  readonly context?: HaContext;
}

export interface HaStateChangedEvent {
  readonly entityId: string;
  readonly oldState: HaStateWithContext | null;
  /** `null` means the entity was removed. */
  readonly newState: HaStateWithContext | null;
}

export interface HaServiceCall {
  readonly domain: string;
  readonly service: string;
  readonly entityId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface SimulatedHomeAssistantOptions {
  /** Deterministic timestamp source; defaults to a counter starting 2026-01-01. */
  readonly now?: () => string;
}

const EMPTY: HaRawSnapshot = { areas: [], devices: [], entities: [], states: [] };

/**
 * In-memory Home Assistant stand-in.
 *
 * It is the state store behind simulation mode and behind the fake WebSocket
 * server used in tests. It performs no I/O of any kind.
 */
export class SimulatedHomeAssistant {
  /** Every service call applied to this store, for assertions. */
  readonly serviceCalls: HaServiceCall[] = [];

  readonly #areas: HaRawSnapshot["areas"];
  readonly #devices: HaRawSnapshot["devices"];
  readonly #entities: HaRawSnapshot["entities"];
  readonly #states = new Map<string, HaStateWithContext>();
  readonly #listeners = new Set<(event: HaStateChangedEvent) => void>();
  readonly #now: () => string;
  #tick = 0;
  #contextCounter = 0;

  constructor(
    snapshot: HaRawSnapshot = EMPTY,
    options: SimulatedHomeAssistantOptions = {},
  ) {
    this.#areas = snapshot.areas;
    this.#devices = snapshot.devices;
    this.#entities = snapshot.entities;
    for (const state of snapshot.states) {
      this.#states.set(state.entity_id, structuredClone(state));
    }
    this.#now =
      options.now ??
      (() => {
        this.#tick += 1;
        return new Date(Date.UTC(2026, 0, 1, 0, 0, this.#tick)).toISOString();
      });
  }

  snapshot(): HaRawSnapshot {
    return structuredClone({
      areas: this.#areas,
      devices: this.#devices,
      entities: this.#entities,
      states: [...this.#states.values()],
    });
  }

  subscribe(listener: (event: HaStateChangedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Apply a service call as Home Assistant would, returning the call's context id. */
  callService(call: HaServiceCall): { readonly contextId: string } {
    this.serviceCalls.push(structuredClone(call));
    const context = this.#newContext();
    if (call.domain === "light") {
      for (const entityId of this.#expandGroup(call.entityId)) {
        this.#applyLight(entityId, call, context);
      }
    }
    return { contextId: context.id };
  }

  /**
   * Simulate another actor (an automation, Adaptive Lighting, a wall switch)
   * changing an entity. The change carries a context Teldra did not originate.
   */
  externalChange(
    entityId: string,
    patch: {
      readonly state?: string;
      readonly attributes?: Readonly<Record<string, unknown>>;
      /** Override HA's timestamp, e.g. to simulate a stale/out-of-order event. */
      readonly lastUpdated?: string;
    },
  ): HaStateChangedEvent {
    return this.#write(entityId, patch, this.#newContext("ext"));
  }

  /** Mutate without emitting, as if the change happened while Teldra was offline. */
  silentChange(
    entityId: string,
    patch: { readonly state?: string; readonly attributes?: Readonly<Record<string, unknown>> },
  ): void {
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    try {
      this.#write(entityId, patch, this.#newContext("ext"));
    } finally {
      for (const listener of listeners) this.#listeners.add(listener);
    }
  }

  removeEntity(entityId: string): void {
    const old = this.#states.get(entityId) ?? null;
    this.#states.delete(entityId);
    this.#emit({ entityId, oldState: old, newState: null });
  }

  #expandGroup(entityId: string): readonly string[] {
    const members = this.#states.get(entityId)?.attributes["entity_id"];
    return Array.isArray(members)
      ? [entityId, ...members.filter((m): m is string => typeof m === "string")]
      : [entityId];
  }

  #applyLight(entityId: string, call: HaServiceCall, context: HaContext): void {
    if (!this.#states.has(entityId)) return;
    if (call.service === "turn_off") {
      this.#write(entityId, { state: "off", attributes: { brightness: null } }, context);
      return;
    }
    if (call.service !== "turn_on") return;
    const attributes: Record<string, unknown> = {};
    const d = call.data;
    if (typeof d["brightness_pct"] === "number") {
      attributes["brightness"] = Math.round((d["brightness_pct"] * 255) / 100);
    }
    if (typeof d["color_temp_kelvin"] === "number") {
      attributes["color_temp_kelvin"] = d["color_temp_kelvin"];
      attributes["color_mode"] = "color_temp";
    }
    if (Array.isArray(d["rgb_color"])) {
      attributes["rgb_color"] = d["rgb_color"];
      attributes["color_mode"] = "rgb";
    }
    if (typeof d["effect"] === "string") attributes["effect"] = d["effect"];
    this.#write(entityId, { state: "on", attributes }, context);
  }

  #write(
    entityId: string,
    patch: {
      readonly state?: string;
      readonly attributes?: Readonly<Record<string, unknown>>;
      readonly lastUpdated?: string;
    },
    context: HaContext,
  ): HaStateChangedEvent {
    const old = this.#states.get(entityId) ?? null;
    const timestamp = patch.lastUpdated ?? this.#now();
    const next: HaStateWithContext = {
      entity_id: entityId,
      state: patch.state ?? old?.state ?? "unknown",
      attributes: { ...(old?.attributes ?? {}), ...(patch.attributes ?? {}) },
      last_changed: patch.state !== undefined && patch.state !== old?.state ? timestamp : (old?.last_changed ?? timestamp),
      last_updated: timestamp,
      context,
    };
    this.#states.set(entityId, next);
    const event = { entityId, oldState: old, newState: structuredClone(next) };
    this.#emit(event);
    return event;
  }

  #emit(event: HaStateChangedEvent): void {
    for (const listener of [...this.#listeners]) listener(structuredClone(event));
  }

  #newContext(prefix = "sim"): HaContext {
    this.#contextCounter += 1;
    return { id: `${prefix}-ctx-${this.#contextCounter}`, parent_id: null, user_id: null };
  }
}
