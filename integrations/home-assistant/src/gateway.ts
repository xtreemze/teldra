import { HaWsClient } from "./client.js";
import type { HaRawSnapshot } from "./inventory.js";
import type {
  HaServiceCall,
  HaStateChangedEvent,
  HaStateWithContext,
  SimulatedHomeAssistant,
} from "./simulation.js";

/**
 * The only surface the sync session uses to talk to "Home Assistant". There are
 * exactly two implementations: an in-memory simulation (no I/O at all) and a
 * WebSocket client. The simulation gateway cannot emit a wire message because it
 * holds no transport.
 */
export interface HaGateway {
  readonly kind: "simulation" | "websocket";
  fetchSnapshot(): Promise<HaRawSnapshot>;
  subscribeStateChanged(listener: (event: HaStateChangedEvent) => void): Promise<void>;
  callService(call: HaServiceCall): Promise<{ readonly contextId: string | null }>;
  onClose(listener: () => void): () => void;
  close(): void;
}

export function simulationGateway(sim: SimulatedHomeAssistant): HaGateway {
  const unsubscribers: Array<() => void> = [];
  return {
    kind: "simulation",
    fetchSnapshot: () => Promise.resolve(sim.snapshot()),
    subscribeStateChanged(listener) {
      unsubscribers.push(sim.subscribe(listener));
      return Promise.resolve();
    },
    callService: (call) => Promise.resolve(sim.callService(call)),
    onClose: () => () => undefined,
    close() {
      for (const off of unsubscribers.splice(0)) off();
    },
  };
}

export function webSocketGateway(client: HaWsClient): HaGateway {
  return {
    kind: "websocket",
    async fetchSnapshot() {
      const [areas, devices, entities, states] = await Promise.all([
        client.request<HaRawSnapshot["areas"]>({ type: "config/area_registry/list" }),
        client.request<HaRawSnapshot["devices"]>({ type: "config/device_registry/list" }),
        client.request<HaRawSnapshot["entities"]>({ type: "config/entity_registry/list" }),
        client.request<HaRawSnapshot["states"]>({ type: "get_states" }),
      ]);
      return { areas, devices, entities, states };
    },
    subscribeStateChanged(listener) {
      return client.subscribeEvents("state_changed", (raw) => {
        const parsed = parseStateChanged(raw);
        if (parsed !== null) listener(parsed);
      });
    },
    async callService(call) {
      const result = await client.callService(call.domain, call.service, call.entityId, call.data);
      return { contextId: result?.context?.id ?? null };
    },
    onClose: (listener) => client.onClose(listener),
    close: () => client.close(),
  };
}

function parseStateChanged(raw: unknown): HaStateChangedEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw as { event_type?: unknown; data?: Record<string, unknown> };
  if (event.event_type !== "state_changed" || event.data === undefined) return null;
  const entityId = event.data["entity_id"];
  if (typeof entityId !== "string") return null;
  return {
    entityId,
    oldState: (event.data["old_state"] ?? null) as HaStateWithContext | null,
    newState: (event.data["new_state"] ?? null) as HaStateWithContext | null,
  };
}
