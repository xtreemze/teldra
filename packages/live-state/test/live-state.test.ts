import { describe, expect, it } from "vitest";
import {
  LiveTwinStore,
  validateLiveEnvelope,
  type DesiredState,
  type Observation,
} from "../src/index.js";

const subject = {
  deviceId: "device:living-room-floor-lamp",
  capabilityId: "cap:living-room-floor-lamp-light",
};

function observation(
  eventId: string,
  sequence: number,
  observedAt: string,
  brightness: number,
): Observation {
  return {
    schemaVersion: "0.1.0",
    kind: "observation",
    eventId,
    subject,
    source: {
      adapter: "test",
      bindingId: "binding:ha-living-room-floor-lamp",
      streamId: "ha:living-room-floor-lamp",
      sequence,
    },
    observedAt,
    receivedAt: observedAt,
    values: {
      power: { kind: "boolean", value: brightness > 0 },
      brightness: { kind: "number", value: brightness, unit: "ratio" },
    },
  };
}

function desired(
  eventId = "desired:1",
  commandId = "command:1",
): DesiredState {
  return {
    schemaVersion: "0.1.0",
    kind: "desired-state",
    eventId,
    commandId,
    subject,
    requestedAt: "2026-10-02T18:00:01Z",
    expiresAt: "2026-10-02T18:00:31Z",
    optimistic: true,
    values: {
      power: { kind: "boolean", value: true },
      brightness: { kind: "number", value: 0.5, unit: "ratio" },
    },
  };
}

describe("Teldra live semantics", () => {
  it("accepts a platform-neutral light observation", () => {
    expect(
      validateLiveEnvelope(
        observation("observation:1", 1, "2026-10-02T18:00:00Z", 0.25),
      ).valid,
    ).toBe(true);
  });

  it("deduplicates replayed events by event ID", () => {
    const store = new LiveTwinStore();
    const event = observation(
      "observation:1",
      1,
      "2026-10-02T18:00:00Z",
      0.25,
    );

    expect(store.apply(event)).toEqual({ status: "applied" });
    expect(store.apply(event)).toEqual({ status: "duplicate" });
  });

  it("does not let an older stream sequence roll observed state backward", () => {
    const store = new LiveTwinStore();

    store.apply(
      observation("observation:2", 2, "2026-10-02T18:00:02Z", 0.8),
    );
    expect(
      store.apply(
        observation("observation:1", 1, "2026-10-02T18:00:03Z", 0.2),
      ),
    ).toEqual({ status: "ignored-older" });

    expect(
      store.getCapability(subject.deviceId, subject.capabilityId)
        .observed?.values.brightness,
    ).toEqual({ kind: "number", value: 0.8, unit: "ratio" });
  });

  it("keeps optimistic desired state distinct from observed truth", () => {
    const store = new LiveTwinStore();
    store.apply(
      observation("observation:1", 1, "2026-10-02T18:00:00Z", 0.25),
    );
    store.apply(desired());

    expect(
      store.getCapability(subject.deviceId, subject.capabilityId)
        .observed?.values.brightness,
    ).toEqual({ kind: "number", value: 0.25, unit: "ratio" });

    expect(
      store.getEffectiveValues(
        subject.deviceId,
        subject.capabilityId,
        "2026-10-02T18:00:02Z",
      ),
    ).toMatchObject({
      source: "desired",
      commandId: "command:1",
      values: {
        brightness: { kind: "number", value: 0.5, unit: "ratio" },
      },
    });
  });

  it("reconciles desired state only when an observation reaches it", () => {
    const store = new LiveTwinStore();
    store.apply(desired());

    store.apply(
      observation("observation:1", 1, "2026-10-02T18:00:02Z", 0.25),
    );
    expect(
      store.getCapability(subject.deviceId, subject.capabilityId).desired,
    ).toBeDefined();

    store.apply(
      observation("observation:2", 2, "2026-10-02T18:00:03Z", 0.5),
    );
    expect(
      store.getCapability(subject.deviceId, subject.capabilityId).desired,
    ).toBeUndefined();
  });

  it("clears desired state on command rejection without changing observed state", () => {
    const store = new LiveTwinStore();
    store.apply(
      observation("observation:1", 1, "2026-10-02T18:00:00Z", 0.25),
    );
    store.apply(desired());

    store.apply({
      schemaVersion: "0.1.0",
      kind: "command-ack",
      eventId: "ack:1",
      commandId: "command:1",
      subject,
      source: {
        adapter: "test",
        streamId: "ha:commands",
        sequence: 1,
      },
      receivedAt: "2026-10-02T18:00:02Z",
      status: "rejected",
      message: "Device unavailable",
    });

    const snapshot = store.getCapability(
      subject.deviceId,
      subject.capabilityId,
    );
    expect(snapshot.desired).toBeUndefined();
    expect(snapshot.observed?.values.brightness).toEqual({
      kind: "number",
      value: 0.25,
      unit: "ratio",
    });
  });

  it("does not treat a completed acknowledgement as observed physical state", () => {
    const store = new LiveTwinStore();
    store.apply(desired());
    store.apply({
      schemaVersion: "0.1.0",
      kind: "command-ack",
      eventId: "ack:1",
      commandId: "command:1",
      subject,
      source: {
        adapter: "test",
        streamId: "ha:commands",
        sequence: 1,
      },
      receivedAt: "2026-10-02T18:00:02Z",
      status: "completed",
    });

    const snapshot = store.getCapability(
      subject.deviceId,
      subject.capabilityId,
    );
    expect(snapshot.observed).toBeUndefined();
    expect(snapshot.desired).toBeDefined();
    expect(snapshot.commandAck?.status).toBe("completed");
  });

  it("derives staleness from observation age instead of availability", () => {
    const store = new LiveTwinStore();
    store.apply(
      observation("observation:1", 1, "2026-10-02T18:00:00Z", 0.25),
    );

    expect(
      store.freshness(
        subject.deviceId,
        subject.capabilityId,
        "2026-10-02T18:00:05Z",
        10_000,
      ),
    ).toBe("fresh");

    expect(
      store.freshness(
        subject.deviceId,
        subject.capabilityId,
        "2026-10-02T18:00:11Z",
        10_000,
      ),
    ).toBe("stale");
  });

  it("keeps device availability separate from capability values", () => {
    const store = new LiveTwinStore();

    store.apply({
      schemaVersion: "0.1.0",
      kind: "availability",
      eventId: "availability:1",
      subject: {
        deviceId: subject.deviceId,
      },
      source: {
        adapter: "test",
        streamId: "ha:availability",
        sequence: 1,
      },
      observedAt: "2026-10-02T18:00:00Z",
      receivedAt: "2026-10-02T18:00:00Z",
      status: "offline",
    });

    const snapshot = store.getCapability(
      subject.deviceId,
      subject.capabilityId,
    );
    expect(snapshot.availability?.status).toBe("offline");
    expect(snapshot.observed).toBeUndefined();
  });
});
