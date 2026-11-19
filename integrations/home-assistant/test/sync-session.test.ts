import { describe, expect, it, vi } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import {
  authorizeControlIntent,
  capabilityAuthorityKey,
  deviceAuthorityKey,
  type ControlAuthoritySnapshot,
  type ControlLease,
} from "@teldra/control-policy";
import type { TwinProject } from "@teldra/domain";
import {
  HomeAssistantModeError,
  SimulatedHomeAssistant,
  createHomeAssistantSyncSession,
  syntheticHomeSnapshot,
  type HaSessionEvent,
  type HaTransportFactory,
  type HomeAssistantSyncOptions,
} from "../src/index.js";
import {
  FAKE_TOKEN,
  FakeHomeAssistantServer,
  ManualScheduler,
  settle,
} from "./support/fake-home-assistant-server.js";

const adapter = "home-assistant";
const deviceId = "device:living-room-floor-lamp";
const capabilityId = "capability:living-room-floor-lamp:light";
const STRIP = "light.sim_strip";

// The golden twin binds the floor lamp to a (synthetic) HA entity id; rebind it
// to the fake server's synthetic strip so leases resolve to a fake entity.
const twin = JSON.parse(
  JSON.stringify(goldenTwin).replaceAll("light.living_room_floor_lamp", STRIP),
) as TwinProject;

function authority(overrides: Partial<ControlAuthoritySnapshot> = {}): ControlAuthoritySnapshot {
  return {
    revision: 1,
    adapters: {
      [adapter]: { read: true, control: true, connection: "connected", connectionRevision: 1 },
    },
    devices: { [deviceAuthorityKey(adapter, deviceId)]: { read: true, control: true } },
    capabilities: {
      [capabilityAuthorityKey(adapter, deviceId, capabilityId)]: { read: true, control: true },
    },
    sessions: {
      "session:studio": { sessionId: "session:studio", allowedOrigins: ["studio"], userPresent: true },
    },
    ...overrides,
  };
}

function lease(commandId: string, snapshot = authority(), overrideDevice = deviceId): ControlLease {
  const decision = authorizeControlIntent(
    snapshot,
    {
      commandId,
      correlationId: "correlation:test",
      target: "physical",
      adapter,
      deviceId: overrideDevice,
      capabilityId,
      capabilityKind: "light",
      origin: { surface: "studio", sessionId: "session:studio" },
    },
    "2026-10-04T16:00:00Z",
  );
  if (!decision.allowed) throw new Error(`fixture lease denied: ${decision.reason}`);
  return decision.lease;
}

function setup(
  mode: "live-monitor" | "live-control",
  extra: Partial<HomeAssistantSyncOptions> = {},
  server = new FakeHomeAssistantServer(),
) {
  const scheduler = new ManualScheduler();
  const events: HaSessionEvent[] = [];
  let currentAuthority = authority();
  const session = createHomeAssistantSyncSession({
    mode,
    connect: server.connect,
    accessToken: () => FAKE_TOKEN,
    authority: () => currentAuthority,
    twin,
    scheduler,
    random: () => 0.5,
    onEvent: (event) => events.push(event),
    ...extra,
  } as HomeAssistantSyncOptions);
  return {
    server,
    scheduler,
    events,
    session,
    setAuthority(next: ControlAuthoritySnapshot) {
      currentAuthority = next;
    },
    statuses: () => events.flatMap((e) => (e.type === "status" ? [e.status] : [])),
    lightEvents: (entityId = STRIP) =>
      events.filter((e) => e.type === "light-state" && e.entityId === entityId),
  };
}

describe("simulation mode (default)", () => {
  it("is the default mode and never touches a transport", async () => {
    const connect = vi.fn<HaTransportFactory>(() => {
      throw new Error("must not connect");
    });
    const server = new FakeHomeAssistantServer();
    const session = createHomeAssistantSyncSession({
      connect,
      accessToken: () => FAKE_TOKEN,
      simulation: new SimulatedHomeAssistant(syntheticHomeSnapshot()),
      onEvent: () => undefined,
    });
    expect(session.mode).toBe("simulation");
    await session.start();

    const outcome = await session.sendLightCommand(STRIP, { kind: "turn_on", brightnessPct: 40 });

    expect(outcome).toMatchObject({ status: "completed", simulated: true });
    expect(connect).not.toHaveBeenCalled();
    expect(server.received).toEqual([]);
    expect(server.connectionCount).toBe(0);
  });

  it("applies commands to the in-memory store and reports simulated, not physical, state", async () => {
    const sim = new SimulatedHomeAssistant(syntheticHomeSnapshot());
    const events: HaSessionEvent[] = [];
    const session = createHomeAssistantSyncSession({ simulation: sim, onEvent: (e) => events.push(e) });
    await session.start();

    await session.sendLightCommand("light.sim_lamp", {
      kind: "turn_on",
      brightnessPct: 250,
      colorTempKelvin: 9000,
    });

    // Validated and clamped before it reached the store.
    expect(sim.serviceCalls).toEqual([
      {
        domain: "light",
        service: "turn_on",
        entityId: "light.sim_lamp",
        data: { brightness_pct: 100, color_temp_kelvin: 6500 },
      },
    ]);
    expect(session.light("light.sim_lamp")?.state).toBe("on");
    expect(events.findLast((e) => e.type === "light-state" && e.entityId === "light.sim_lamp")).toMatchObject({
      origin: "teldra-echo",
      simulated: true,
    });
  });

  it("rejects invalid requests without applying them", async () => {
    const sim = new SimulatedHomeAssistant(syntheticHomeSnapshot());
    const session = createHomeAssistantSyncSession({ simulation: sim, onEvent: () => undefined });
    await session.start();
    const outcome = await session.sendLightCommand("light.sim_ceiling", {
      kind: "turn_on",
      colorTempKelvin: 3000,
    });
    expect(outcome).toMatchObject({ status: "rejected", error: { code: "unsupported-color-temp" } });
    expect(await session.sendLightCommand("light.nope", { kind: "turn_off" })).toMatchObject({
      status: "rejected",
      error: { code: "unknown-entity" },
    });
    expect(sim.serviceCalls).toEqual([]);
  });

  it("works with a default empty store", async () => {
    const session = createHomeAssistantSyncSession({ onEvent: () => undefined });
    await session.start();
    expect(session.inventory().lights).toEqual([]);
  });
});

describe("construction guards", () => {
  it("live modes require a transport factory and token", () => {
    expect(() => createHomeAssistantSyncSession({ mode: "live-monitor", onEvent: () => undefined } as never)).toThrow(
      HomeAssistantModeError,
    );
  });

  it("live-control refuses to construct without an adapter control grant", () => {
    const server = new FakeHomeAssistantServer();
    const noGrant = authority({
      adapters: { [adapter]: { read: true, control: false, connection: "connected", connectionRevision: 1 } },
    });
    expect(() =>
      createHomeAssistantSyncSession({
        mode: "live-control",
        connect: server.connect,
        accessToken: () => FAKE_TOKEN,
        authority: () => noGrant,
        twin,
        onEvent: () => undefined,
      }),
    ).toThrow(HomeAssistantModeError);
  });
});

describe("live-monitor mode", () => {
  it("connects, reads registries and states, subscribes, and discovers the inventory", async () => {
    const h = setup("live-monitor");
    await h.session.start();
    await settle();

    expect(h.statuses()).toEqual(["connecting", "connected"]);
    const types = h.server.received.map((m) => m.message["type"]);
    expect(types).toEqual(
      expect.arrayContaining([
        "auth",
        "subscribe_events",
        "config/area_registry/list",
        "config/device_registry/list",
        "config/entity_registry/list",
        "get_states",
      ]),
    );
    expect(h.session.inventory().lights.map((l) => l.entityId)).toContain(STRIP);
    expect(h.session.inventory().groups).toHaveLength(1);
    expect(h.session.inventory().scenes).toHaveLength(1);
  });

  it("rejects every command and sends no call_service", async () => {
    const h = setup("live-monitor");
    await h.session.start();

    expect(() => h.session.sendLightCommand(STRIP, { kind: "turn_off" })).toThrow(HomeAssistantModeError);
    expect(h.server.messagesOfType("call_service")).toEqual([]);
  });

  it("still tracks external changes read-only", async () => {
    const h = setup("live-monitor");
    await h.session.start();
    h.server.sim.externalChange(STRIP, { state: "off" });
    await settle();
    expect(h.session.light(STRIP)?.state).toBe("off");
    expect(h.lightEvents().at(-1)).toMatchObject({ origin: "external" });
  });

  it("does not retain the access token in events", async () => {
    const h = setup("live-monitor");
    await h.session.start();
    expect(JSON.stringify(h.events)).not.toContain(FAKE_TOKEN);
  });
});

describe("live-control mode", () => {
  it("sends a clamped call_service for a valid lease and completes", async () => {
    const h = setup("live-control");
    await h.session.start();

    const outcome = await h.session.sendLightCommand(
      STRIP,
      { kind: "turn_on", brightnessPct: 500, rgbColor: [255, 0, 10] },
      lease("command:1"),
    );

    expect(outcome).toMatchObject({ status: "completed", simulated: false });
    const calls = h.server.messagesOfType("call_service");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toMatchObject({
      domain: "light",
      service: "turn_on",
      target: { entity_id: STRIP },
      service_data: { brightness_pct: 100, rgb_color: [255, 0, 10] },
    });
  });

  it("denies without a lease and sends nothing", async () => {
    const h = setup("live-control");
    await h.session.start();
    expect(await h.session.sendLightCommand(STRIP, { kind: "turn_off" })).toEqual({
      status: "denied",
      reason: "lease-required",
    });
    expect(h.server.messagesOfType("call_service")).toEqual([]);
  });

  it("denies when authority changed after the lease was issued (revalidated at send)", async () => {
    const h = setup("live-control");
    await h.session.start();
    const l = lease("command:2");
    h.setAuthority(authority({ revision: 2 }));
    expect(await h.session.sendLightCommand(STRIP, { kind: "turn_off" }, l)).toEqual({
      status: "denied",
      reason: "authority-changed",
    });
    expect(h.server.messagesOfType("call_service")).toEqual([]);
  });

  it("denies a lease whose binding does not resolve to the target entity", async () => {
    const h = setup("live-control");
    await h.session.start();
    expect(await h.session.sendLightCommand("light.sim_lamp", { kind: "turn_off" }, lease("command:3"))).toEqual({
      status: "denied",
      reason: "lease-entity-mismatch",
    });
    expect(h.server.messagesOfType("call_service")).toEqual([]);
  });

  it("reports a rejected service call as failed", async () => {
    const h = setup("live-control");
    await h.session.start();
    h.server.failNextServiceCall();
    expect(await h.session.sendLightCommand(STRIP, { kind: "turn_off" }, lease("command:4"))).toMatchObject({
      status: "failed",
    });
  });
});

describe("echo and feedback-loop suppression", () => {
  it("labels the state change caused by a Teldra command as teldra-echo", async () => {
    const h = setup("live-control");
    await h.session.start();
    await h.session.sendLightCommand(STRIP, { kind: "turn_off" }, lease("command:5"));
    await settle();
    expect(h.lightEvents().at(-1)).toMatchObject({ origin: "teldra-echo", state: "off" });
  });

  it("recognizes the echo even when the event arrives before the call result", async () => {
    const h = setup("live-control");
    await h.session.start();
    const baseline = h.lightEvents().length; // initial reconcile event
    h.server.holdResults();
    const pending = h.session.sendLightCommand(STRIP, { kind: "turn_off" }, lease("command:6"));
    await settle();
    // The state_changed event is already delivered; the result is still held.
    expect(h.session.light(STRIP)?.state).toBe("off");
    expect(h.lightEvents()).toHaveLength(baseline); // classification deferred, not mislabeled
    h.server.releaseResults();
    await pending;
    await settle();
    expect(h.lightEvents()).toHaveLength(baseline + 1);
    expect(h.lightEvents().at(-1)).toMatchObject({ origin: "teldra-echo" });
  });

  it("labels other actors' changes external", async () => {
    const h = setup("live-control");
    await h.session.start();
    await h.session.sendLightCommand(STRIP, { kind: "turn_off" }, lease("command:7"));
    h.server.sim.externalChange(STRIP, { state: "on" });
    await settle();
    expect(h.lightEvents().at(-1)).toMatchObject({ origin: "external", state: "on" });
  });

  it("does not issue follow-up service calls in response to echoes or external changes", async () => {
    const h = setup("live-control");
    await h.session.start();
    await h.session.sendLightCommand(STRIP, { kind: "turn_off" }, lease("command:8"));
    h.server.sim.externalChange(STRIP, { state: "on" });
    await settle();
    expect(h.server.messagesOfType("call_service")).toHaveLength(1);
  });

  it("ignores state older than what it already holds (last writer by HA timestamp)", async () => {
    const h = setup("live-monitor");
    await h.session.start();
    h.server.sim.externalChange(STRIP, { state: "off" });
    await settle();
    const before = h.lightEvents().length;
    h.server.sim.externalChange(STRIP, { state: "on", lastUpdated: "2020-01-01T00:00:00.000Z" });
    await settle();
    expect(h.session.light(STRIP)?.state).toBe("off");
    expect(h.lightEvents()).toHaveLength(before);
  });
});

describe("throttling and coalescing", () => {
  it("sends the first command at once, coalesces bursts, and sends only the latest after the interval", async () => {
    const h = setup("live-control", { minCommandIntervalMs: 250 });
    await h.session.start();

    const first = h.session.sendLightCommand(STRIP, { kind: "turn_on", brightnessPct: 10 }, lease("command:a"));
    await settle();
    const second = h.session.sendLightCommand(STRIP, { kind: "turn_on", brightnessPct: 20 }, lease("command:b"));
    const third = h.session.sendLightCommand(STRIP, { kind: "turn_on", brightnessPct: 30 }, lease("command:c"));
    await settle();

    expect(h.server.messagesOfType("call_service")).toHaveLength(1);
    expect(await second).toEqual({ status: "coalesced", supersededBy: "command:c" });

    await h.scheduler.advance(250);
    const sent = h.server.messagesOfType("call_service").map((m) => (m.message["service_data"] as { brightness_pct: number }).brightness_pct);
    expect(sent).toEqual([10, 30]);
    expect(await first).toMatchObject({ status: "completed" });
    expect(await third).toMatchObject({ status: "completed" });
  });

  it("revalidates the lease when a coalesced command finally transmits", async () => {
    const h = setup("live-control", { minCommandIntervalMs: 250 });
    await h.session.start();
    await h.session.sendLightCommand(STRIP, { kind: "turn_off" }, lease("command:f"));
    const delayed = h.session.sendLightCommand(STRIP, { kind: "turn_on" }, lease("command:g"));
    h.setAuthority(authority({ revision: 9 }));
    await h.scheduler.advance(250);
    expect(await delayed).toEqual({ status: "denied", reason: "authority-changed" });
    expect(h.server.messagesOfType("call_service")).toHaveLength(1);
  });
});

describe("reconnection and reconciliation", () => {
  it("reconnects with exponential backoff and reports retry timing", async () => {
    const h = setup("live-monitor");
    await h.session.start();
    h.server.refuseNextConnections(2);
    h.server.dropAll();
    await settle();

    const retries = () =>
      h.events.flatMap((e) => (e.type === "status" && e.status === "reconnecting" ? [e.retryInMs] : []));
    expect(retries()).toEqual([1000]);
    await h.scheduler.advance(1000);
    expect(retries()).toEqual([1000, 2000]);
    await h.scheduler.advance(2000);
    expect(retries()).toEqual([1000, 2000, 4000]);
    await h.scheduler.advance(4000);
    expect(h.statuses().at(-1)).toBe("connected");
    expect(h.server.openConnections).toBe(1);
  });

  it("fully reconciles after reconnect, surfacing changes made while offline", async () => {
    const h = setup("live-monitor");
    await h.session.start();
    h.server.dropAll();
    await settle();
    h.server.sim.silentChange("light.sim_lamp", { state: "on" });
    h.server.sim.removeEntity("light.sim_ceiling");
    await h.scheduler.advance(1000);

    const reconciled = h.events.filter((e) => e.type === "reconciled");
    expect(reconciled.at(-1)).toMatchObject({
      reason: "reconnect",
      changed: ["light.sim_lamp"],
      removed: ["light.sim_ceiling"],
    });
    expect(h.session.light("light.sim_lamp")?.state).toBe("on");
    expect(h.session.inventory().lights.find((l) => l.entityId === "light.sim_ceiling")?.available).toBe(false);
    expect(h.lightEvents("light.sim_lamp").at(-1)).toMatchObject({ origin: "reconcile", state: "on" });
  });

  it("resets backoff after a successful reconnect", async () => {
    const h = setup("live-monitor");
    await h.session.start();
    h.server.dropAll();
    await h.scheduler.advance(1000);
    h.server.dropAll();
    await settle();
    const retries = h.events.flatMap((e) => (e.type === "status" && e.status === "reconnecting" ? [e.retryInMs] : []));
    expect(retries).toEqual([1000, 1000]);
  });

  it("never retries an in-flight command whose outcome became unknown", async () => {
    const h = setup("live-control");
    await h.session.start();
    h.server.holdResults();
    const pending = h.session.sendLightCommand(STRIP, { kind: "turn_off" }, lease("command:h"));
    await settle();
    h.server.dropAll();
    expect(await pending).toEqual({ status: "outcome-unknown" });
    h.server.releaseResults();
    await h.scheduler.advance(1000);
    expect(h.statuses().at(-1)).toBe("connected");
    expect(h.server.messagesOfType("call_service")).toHaveLength(1);
  });

  it("drops commands still waiting in the coalescing lane when the connection is lost", async () => {
    const h = setup("live-control", { minCommandIntervalMs: 250 });
    await h.session.start();
    await h.session.sendLightCommand(STRIP, { kind: "turn_off" }, lease("command:i"));
    const waiting = h.session.sendLightCommand(STRIP, { kind: "turn_on" }, lease("command:j"));
    h.server.dropAll();
    await settle();
    expect(await waiting).toEqual({ status: "dropped" });
    await h.scheduler.advance(5000);
    expect(h.server.messagesOfType("call_service")).toHaveLength(1);
  });

  it("does not retry after the token is rejected", async () => {
    const h = setup("live-monitor", { accessToken: () => "wrong" });
    await h.session.start();
    await settle();
    expect(h.statuses().at(-1)).toBe("auth-failed");
    expect(h.scheduler.pendingTimers).toBe(0);
    expect(h.server.connectionCount).toBe(1);
  });

  it("stop() cancels pending reconnects and closes the connection", async () => {
    const h = setup("live-monitor");
    await h.session.start();
    h.server.dropAll();
    await settle();
    h.session.stop();
    await h.scheduler.advance(60_000);
    expect(h.server.connectionCount).toBe(1);
    expect(h.statuses().at(-1)).toBe("stopped");
  });
});

describe("Adaptive Lighting awareness", () => {
  it("re-publishes the inventory when an Adaptive Lighting switch changes, read-only", async () => {
    const h = setup("live-monitor");
    await h.session.start();
    expect(h.session.light("light.sim_group_living")?.adaptiveLighting.mayBeOverridden).toBe(true);

    h.server.sim.externalChange("switch.adaptive_lighting_sim_living", { state: "off" });
    await settle();

    expect(h.session.light("light.sim_group_living")?.adaptiveLighting.mayBeOverridden).toBe(false);
    expect(h.events.filter((e) => e.type === "inventory").length).toBeGreaterThanOrEqual(2);
    expect(h.server.messagesOfType("call_service")).toEqual([]);
  });
});
