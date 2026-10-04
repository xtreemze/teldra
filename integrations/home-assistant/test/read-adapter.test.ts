import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import {
  validateDiagnosticEvent,
  type DiagnosticEvent,
} from "@teldra/diagnostics";
import type { TwinProject } from "@teldra/domain";
import {
  LiveTwinStore,
  type TeldraLiveEnvelope,
} from "@teldra/live-state";
import {
  HomeAssistantReadAdapter,
  type HomeAssistantMessageEvent,
  type HomeAssistantWebSocket,
} from "../src/index.js";

const fixture = goldenTwin as TwinProject;
const deviceId = "device:living-room-floor-lamp";
const capabilityId = "capability:living-room-floor-lamp:light";

class FakeSocket implements HomeAssistantWebSocket {
  readonly sent: string[] = [];
  readonly #listeners = new Set<
    (event: HomeAssistantMessageEvent) => void
  >();
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  addEventListener(
    _type: "message",
    listener: (event: HomeAssistantMessageEvent) => void,
  ): void {
    this.#listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: HomeAssistantMessageEvent) => void,
  ): void {
    this.#listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(value: unknown): void {
    const event = { data: JSON.stringify(value) };
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

function harness() {
  const envelopes: TeldraLiveEnvelope[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  let tick = 0;

  const adapter = new HomeAssistantReadAdapter(fixture, {
    onEnvelope: (envelope) => envelopes.push(envelope),
    onDiagnostic: (event) => diagnostics.push(event),
    now: () => `2026-10-04T12:00:0${tick++}Z`,
  });

  return { adapter, envelopes, diagnostics };
}

describe("HomeAssistantReadAdapter", () => {
  it("authenticates, fetches states, subscribes, and normalizes the bound Golden Home light", () => {
    const { adapter, envelopes, diagnostics } = harness();
    const socket = new FakeSocket();

    adapter.attach(socket, "test-access-token");
    socket.emit({ type: "auth_required" });

    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      type: "auth",
      access_token: "test-access-token",
    });

    socket.emit({ type: "auth_ok" });

    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({
      id: 1,
      type: "get_states",
    });
    expect(JSON.parse(socket.sent[2] ?? "{}")).toEqual({
      id: 2,
      type: "subscribe_events",
      event_type: "state_changed",
    });

    socket.emit({
      id: 1,
      type: "result",
      success: true,
      result: [
        {
          entity_id: "light.living_room_floor_lamp",
          state: "on",
          attributes: {
            brightness: 128,
            rgb_color: [255, 128, 0],
          },
          last_changed: "2026-10-04T11:59:58Z",
          last_updated: "2026-10-04T11:59:59Z",
        },
        {
          entity_id: "sun.sun",
          state: "above_horizon",
          attributes: {},
          last_changed: "2026-10-04T11:00:00Z",
        },
      ],
    });

    const store = new LiveTwinStore();
    for (const envelope of envelopes) {
      expect(store.apply(envelope).status).toBe("applied");
    }

    const snapshot = store.getCapability(deviceId, capabilityId);
    expect(snapshot.availability?.status).toBe("online");
    expect(snapshot.observed?.observedAt).toBe("2026-10-04T11:59:59Z");
    expect(snapshot.observed?.values).toEqual({
      power: { kind: "boolean", value: true },
      brightness: {
        kind: "number",
        value: 128 / 255,
        unit: "ratio",
      },
      color: {
        kind: "rgb",
        value: [1, 128 / 255, 0],
      },
    });

    expect(diagnostics.some((event) =>
      event.code === "home-assistant.state.ignored-unbound"
    )).toBe(true);

    for (const event of diagnostics) {
      expect(validateDiagnosticEvent(event).valid).toBe(true);
    }

    expect(JSON.stringify(envelopes)).not.toContain("test-access-token");
    expect(JSON.stringify(diagnostics)).not.toContain("test-access-token");
  });

  it("turns unavailable state into availability without replacing the last observation", () => {
    const { adapter, envelopes } = harness();
    const store = new LiveTwinStore();

    const online = adapter.ingestState({
      entity_id: "light.living_room_floor_lamp",
      state: "on",
      attributes: { brightness: 255 },
      last_changed: "2026-10-04T12:00:00Z",
    });

    for (const envelope of online) {
      store.apply(envelope);
    }

    const observed = store.getCapability(deviceId, capabilityId).observed;
    expect(observed?.values.power).toEqual({
      kind: "boolean",
      value: true,
    });

    const unavailable = adapter.ingestState({
      entity_id: "light.living_room_floor_lamp",
      state: "unavailable",
      attributes: {},
      last_changed: "2026-10-04T12:01:00Z",
    });

    for (const envelope of unavailable) {
      store.apply(envelope);
    }

    const snapshot = store.getCapability(deviceId, capabilityId);
    expect(snapshot.availability?.status).toBe("unavailable");
    expect(snapshot.observed).toEqual(observed);
    expect(envelopes.filter((event) => event.kind === "observation")).toHaveLength(1);
  });

  it("maps state_changed events and removed entities without exposing a command surface", () => {
    const { adapter, envelopes } = harness();
    const socket = new FakeSocket();

    adapter.attach(socket, "token");
    socket.emit({ type: "auth_ok" });

    socket.emit({
      id: 2,
      type: "event",
      event: {
        event_type: "state_changed",
        time_fired: "2026-10-04T12:02:00Z",
        data: {
          entity_id: "light.living_room_floor_lamp",
          old_state: null,
          new_state: {
            entity_id: "light.living_room_floor_lamp",
            state: "off",
            attributes: {},
            last_changed: "2026-10-04T12:02:00Z",
          },
        },
      },
    });

    socket.emit({
      id: 2,
      type: "event",
      event: {
        event_type: "state_changed",
        time_fired: "2026-10-04T12:03:00Z",
        data: {
          entity_id: "light.living_room_floor_lamp",
          old_state: null,
          new_state: null,
        },
      },
    });

    expect(
      envelopes.some((event) => {
        if (event.kind !== "observation") return false;
        const power = event.values.power;
        return (
          power?.kind === "boolean" &&
          power.value === false
        );
      }),
    ).toBe(true);

    expect(envelopes.at(-1)).toMatchObject({
      kind: "availability",
      status: "unavailable",
    });

    expect("callService" in adapter).toBe(false);
    expect("sendCommand" in adapter).toBe(false);
  });

  it("preserves LiveTwinStore ordering semantics for older adapter sequences", () => {
    const { adapter } = harness();

    const first = adapter.ingestState({
      entity_id: "light.living_room_floor_lamp",
      state: "on",
      attributes: {},
      last_changed: "2026-10-04T12:04:00Z",
    });

    const second = adapter.ingestState({
      entity_id: "light.living_room_floor_lamp",
      state: "off",
      attributes: {},
      last_changed: "2026-10-04T12:05:00Z",
    });

    const firstObservation = first.find((event) => event.kind === "observation");
    const secondObservation = second.find((event) => event.kind === "observation");

    expect(firstObservation).toBeDefined();
    expect(secondObservation).toBeDefined();
    if (
      firstObservation === undefined ||
      secondObservation === undefined
    ) {
      return;
    }

    const store = new LiveTwinStore();
    expect(store.apply(secondObservation).status).toBe("applied");
    expect(store.apply(firstObservation).status).toBe("ignored-older");
    expect(
      store.getCapability(deviceId, capabilityId).observed?.values.power,
    ).toEqual({
      kind: "boolean",
      value: false,
    });
  });

  it("closes on invalid authentication without leaking the token into diagnostics", () => {
    const { adapter, diagnostics } = harness();
    const socket = new FakeSocket();

    adapter.attach(socket, "super-secret-token");
    socket.emit({ type: "auth_invalid", message: "bad token" });

    expect(socket.closed).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain("super-secret-token");
    expect(diagnostics.at(-1)?.code).toBe(
      "home-assistant.connection.auth-invalid",
    );
  });
});
