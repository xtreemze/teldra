import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import {
  authorizeControlIntent,
  capabilityAuthorityKey,
  deviceAuthorityKey,
  type ControlAuthoritySnapshot,
  type ControlIntent,
} from "@teldra/control-policy";
import type { TwinProject } from "@teldra/domain";
import {
  LiveTwinStore,
  type TeldraLiveEnvelope,
} from "@teldra/live-state";
import {
  HomeAssistantControlAdapter,
  type HomeAssistantMessageEvent,
  type HomeAssistantWebSocket,
} from "../src/index.js";

const fixture = goldenTwin as TwinProject;
const adapterName = "home-assistant";
const deviceId = "device:living-room-floor-lamp";
const capabilityId = "capability:living-room-floor-lamp:light";

class FakeSocket implements HomeAssistantWebSocket {
  readonly sent: string[] = [];
  readonly #listeners = new Set<
    (event: HomeAssistantMessageEvent) => void
  >();

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

  emit(value: unknown): void {
    const event = { data: JSON.stringify(value) };
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

function authority(): ControlAuthoritySnapshot {
  return {
    revision: 11,
    adapters: {
      [adapterName]: {
        read: true,
        control: true,
        connection: "connected",
        connectionRevision: 4,
      },
    },
    devices: {
      [deviceAuthorityKey(adapterName, deviceId)]: {
        read: true,
        control: true,
      },
    },
    capabilities: {
      [capabilityAuthorityKey(adapterName, deviceId, capabilityId)]: {
        read: true,
        control: true,
      },
    },
    sessions: {
      "session:studio": {
        sessionId: "session:studio",
        allowedOrigins: ["studio"],
        userPresent: true,
      },
    },
  };
}

function intent(commandId = "command:light:on"): ControlIntent {
  return {
    commandId,
    correlationId: "correlation:studio-light",
    target: "physical",
    adapter: adapterName,
    deviceId,
    capabilityId,
    capabilityKind: "light",
    origin: {
      surface: "studio",
      sessionId: "session:studio",
    },
  };
}

function lease(snapshot = authority()) {
  const decision = authorizeControlIntent(
    snapshot,
    intent(),
    "2026-10-04T16:00:00Z",
  );
  expect(decision.allowed).toBe(true);
  if (!decision.allowed) {
    throw new Error("Expected fixture control lease.");
  }
  return decision.lease;
}

function harness(snapshot = authority()) {
  const envelopes: TeldraLiveEnvelope[] = [];
  let currentAuthority = snapshot;
  let tick = 0;
  const adapter = new HomeAssistantControlAdapter(fixture, {
    authority: () => currentAuthority,
    onEnvelope: (envelope) => envelopes.push(envelope),
    now: () => `2026-10-04T16:00:0${tick++}Z`,
    requestIdStart: 100,
  });

  return {
    adapter,
    envelopes,
    setAuthority(next: ControlAuthoritySnapshot) {
      currentAuthority = next;
    },
  };
}

describe("HomeAssistantControlAdapter", () => {
  it("revalidates a light lease immediately before dispatch and sends the official call_service shape", () => {
    const state = authority();
    const { adapter, envelopes } = harness(state);
    const socket = new FakeSocket();
    adapter.attach(socket);

    const result = adapter.dispatchLightPower(lease(state), true);

    expect(result).toEqual({
      status: "dispatched",
      requestId: 100,
    });
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      id: 100,
      type: "call_service",
      domain: "light",
      service: "turn_on",
      target: {
        entity_id: "light.living_room_floor_lamp",
      },
      return_response: false,
    });

    expect(envelopes[0]).toMatchObject({
      kind: "desired-state",
      commandId: "command:light:on",
      subject: {
        deviceId,
        capabilityId,
      },
      values: {
        power: {
          kind: "boolean",
          value: true,
        },
      },
      optimistic: true,
    });
  });

  it("maps Home Assistant result success to command completion while observation remains authoritative", () => {
    const state = authority();
    const { adapter, envelopes } = harness(state);
    const socket = new FakeSocket();
    const store = new LiveTwinStore();

    adapter.attach(socket);
    adapter.dispatchLightPower(lease(state), false);

    for (const envelope of envelopes) {
      store.apply(envelope);
    }

    expect(store.getCapability(deviceId, capabilityId).desired?.values.power).toEqual({
      kind: "boolean",
      value: false,
    });

    socket.emit({
      id: 100,
      type: "result",
      success: true,
      result: {
        context: {
          id: "ha-context",
        },
        response: null,
      },
    });

    const completion = envelopes.at(-1);
    expect(completion).toMatchObject({
      kind: "command-ack",
      commandId: "command:light:on",
      status: "completed",
    });
    store.apply(completion!);

    expect(store.getCapability(deviceId, capabilityId).commandAck?.status).toBe(
      "completed",
    );
    expect(store.getCapability(deviceId, capabilityId).desired).toBeDefined();
    expect(store.getCapability(deviceId, capabilityId).observed).toBeUndefined();
  });

  it("maps Home Assistant result failure to failed acknowledgement and clears optimistic desired state", () => {
    const state = authority();
    const { adapter, envelopes } = harness(state);
    const socket = new FakeSocket();
    const store = new LiveTwinStore();

    adapter.attach(socket);
    adapter.dispatchLightPower(lease(state), true);

    store.apply(envelopes[0]!);

    socket.emit({
      id: 100,
      type: "result",
      success: false,
      result: null,
    });

    store.apply(envelopes.at(-1)!);

    expect(store.getCapability(deviceId, capabilityId).commandAck?.status).toBe(
      "failed",
    );
    expect(store.getCapability(deviceId, capabilityId).desired).toBeUndefined();
  });

  it("refuses dispatch when authority changes after the lease was issued", () => {
    const original = authority();
    const { adapter, envelopes, setAuthority } = harness(original);
    const socket = new FakeSocket();
    adapter.attach(socket);

    setAuthority({
      ...original,
      revision: original.revision + 1,
      capabilities: {
        ...original.capabilities,
        [capabilityAuthorityKey(adapterName, deviceId, capabilityId)]: {
          read: true,
          control: false,
        },
      },
    });

    expect(adapter.dispatchLightPower(lease(original), true)).toEqual({
      status: "denied",
      reason: "authority-changed",
    });
    expect(socket.sent).toHaveLength(0);
    expect(envelopes.at(-1)).toMatchObject({
      kind: "command-ack",
      status: "rejected",
    });
  });

  it("refuses dispatch when adapter connectivity changes after lease issue", () => {
    const original = authority();
    const { adapter, setAuthority } = harness(original);
    const socket = new FakeSocket();
    adapter.attach(socket);

    setAuthority({
      ...original,
      adapters: {
        [adapterName]: {
          ...original.adapters[adapterName]!,
          connection: "disconnected",
          connectionRevision:
            original.adapters[adapterName]!.connectionRevision + 1,
        },
      },
    });

    expect(adapter.dispatchLightPower(lease(original), false)).toEqual({
      status: "denied",
      reason: "connection-changed",
    });
    expect(socket.sent).toHaveLength(0);
  });

  it("requires an attached command channel even when policy authority is valid", () => {
    const state = authority();
    const { adapter } = harness(state);

    expect(adapter.dispatchLightPower(lease(state), true)).toEqual({
      status: "denied",
      reason: "not-attached",
    });
  });

  it("does not expose credentials or add physical commands to canonical history", () => {
    const state = authority();
    const { adapter, envelopes } = harness(state);
    const socket = new FakeSocket();
    adapter.attach(socket);

    adapter.dispatchLightPower(lease(state), true);

    expect(JSON.stringify(socket.sent)).not.toContain("access_token");
    expect(JSON.stringify(envelopes)).not.toContain("access_token");
    expect("execute" in adapter).toBe(false);
    expect("undo" in adapter).toBe(false);
    expect("redo" in adapter).toBe(false);
  });
});
