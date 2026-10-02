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

  it("reconciles semantically equal values regardless of JSON property order", () => {
    const store = new LiveTwinStore();
    store.apply(desired());

    const reached: Observation = {
      ...observation("observation:ordered", 1, "2026-10-02T18:00:03Z", 0.5),
      values: {
        power: { value: true, kind: "boolean" },
        brightness: { unit: "ratio", value: 0.5, kind: "number" },
      },
    };

    store.apply(reached);

    expect(
      store.getCapability(subject.deviceId, subject.capabilityId).desired,
    ).toBeUndefined();
  });

  it("lets newer device availability override older capability availability", () => {
    const store = new LiveTwinStore();

    store.apply({
      schemaVersion: "0.1.0",
      kind: "availability",
      eventId: "availability:capability-online",
      subject,
      source: {
        adapter: "test",
        streamId: "ha:availability",
        sequence: 1,
      },
      observedAt: "2026-10-02T18:00:00Z",
      receivedAt: "2026-10-02T18:00:00Z",
      status: "online",
    });

    store.apply({
      schemaVersion: "0.1.0",
      kind: "availability",
      eventId: "availability:device-offline",
      subject: { deviceId: subject.deviceId },
      source: {
        adapter: "test",
        streamId: "ha:availability",
        sequence: 2,
      },
      observedAt: "2026-10-02T18:00:01Z",
      receivedAt: "2026-10-02T18:00:01Z",
      status: "offline",
    });

    expect(
      store.getCapability(subject.deviceId, subject.capabilityId).availability
        ?.status,
    ).toBe("offline");
  });

  it("expires desired state explicitly at its timeout", () => {
    const store = new LiveTwinStore();
    store.apply(
      observation("observation:before-desired", 1, "2026-10-02T18:00:00Z", 0.25),
    );
    store.apply(desired());

    expect(store.expireDesiredStates("2026-10-02T18:00:30Z")).toBe(0);
    expect(store.expireDesiredStates("2026-10-02T18:00:31Z")).toBe(1);

    expect(
      store.getCapability(subject.deviceId, subject.capabilityId).desired,
    ).toBeUndefined();
    expect(
      store.getEffectiveValues(
        subject.deviceId,
        subject.capabilityId,
        "2026-10-02T18:00:31Z",
      ),
    ).toMatchObject({
      source: "observed",
      values: {
        brightness: { kind: "number", value: 0.25, unit: "ratio" },
      },
    });
  });

  it("does not let an older acknowledgement replace a newer command lifecycle", () => {
    const store = new LiveTwinStore();
    store.apply(desired("desired:new", "command:new"));

    expect(
      store.apply({
        schemaVersion: "0.1.0",
        kind: "command-ack",
        eventId: "ack:new",
        commandId: "command:new",
        subject,
        source: {
          adapter: "test",
          streamId: "ha:commands",
          sequence: 2,
        },
        receivedAt: "2026-10-02T18:00:05Z",
        status: "accepted",
      }),
    ).toEqual({ status: "applied" });

    expect(
      store.apply({
        schemaVersion: "0.1.0",
        kind: "command-ack",
        eventId: "ack:old",
        commandId: "command:old",
        subject,
        source: {
          adapter: "test",
          streamId: "ha:commands",
          sequence: 1,
        },
        receivedAt: "2026-10-02T18:00:03Z",
        status: "failed",
      }),
    ).toEqual({ status: "ignored-older" });

    expect(
      store.getCapability(subject.deviceId, subject.capabilityId).commandAck
        ?.commandId,
    ).toBe("command:new");
  });

  it("keeps distinct canonical subjects distinct even when IDs contain separators", () => {
    const store = new LiveTwinStore();

    const first: Observation = {
      ...observation("observation:first", 1, "2026-10-02T18:00:00Z", 0.1),
      subject: {
        deviceId: "device:a\u0000b",
        capabilityId: "cap:c",
      },
    };
    const second: Observation = {
      ...observation("observation:second", 1, "2026-10-02T18:00:01Z", 0.9),
      subject: {
        deviceId: "device:a",
        capabilityId: "b\u0000cap:c",
      },
    };

    store.apply(first);
    store.apply(second);

    expect(
      store.getCapability(first.subject.deviceId, first.subject.capabilityId)
        .observed?.values.brightness,
    ).toEqual({ kind: "number", value: 0.1, unit: "ratio" });
    expect(
      store.getCapability(second.subject.deviceId, second.subject.capabilityId)
        .observed?.values.brightness,
    ).toEqual({ kind: "number", value: 0.9, unit: "ratio" });
  });

});
