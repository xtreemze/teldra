import { describe, expect, it } from "vitest";
import type { TeldraLiveEnvelope } from "@teldra/live-state";
import { StudioLiveStateController } from "./StudioLiveStateController";

const observation: TeldraLiveEnvelope = {
  schemaVersion: "0.1.0",
  kind: "observation",
  eventId: "event:1",
  subject: {
    deviceId: "device:lamp",
    capabilityId: "capability:lamp:light",
  },
  source: {
    adapter: "fixture",
    streamId: "fixture:lamp",
    sequence: 1,
  },
  observedAt: "2026-10-04T12:00:00Z",
  receivedAt: "2026-10-04T12:00:00Z",
  values: {
    power: { kind: "boolean", value: true },
  },
};

describe("StudioLiveStateController", () => {
  it("publishes applied live-state changes without canonical persistence authority", () => {
    const controller = new StudioLiveStateController();
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });

    expect(controller.revision).toBe(0);
    expect(controller.apply(observation)).toEqual({ status: "applied" });
    expect(controller.revision).toBe(1);
    expect(notifications).toBe(1);
    expect(
      controller.getCapability(
        "device:lamp",
        "capability:lamp:light",
      ).observed?.values.power,
    ).toEqual({ kind: "boolean", value: true });

    expect(controller.apply(observation)).toEqual({ status: "duplicate" });
    expect(controller.revision).toBe(1);
    expect(notifications).toBe(1);

    unsubscribe();
  });
});
