import { describe, expect, it } from "vitest";
import {
  capabilityAuthorityKey,
  deviceAuthorityKey,
  type ControlAuthoritySnapshot,
  type ControlLease,
} from "@teldra/control-policy";
import type { HomeAssistantControlDispatchResult } from "@teldra/home-assistant";
import {
  StudioPhysicalControlController,
  type StudioPhysicalCommandAdapter,
} from "./StudioPhysicalControlController";

const adapterName = "home-assistant";
const deviceId = "device:living-room-floor-lamp";
const capabilityId = "capability:living-room-floor-lamp:light";

function authority(control = true): ControlAuthoritySnapshot {
  return {
    revision: 2,
    adapters: {
      [adapterName]: {
        read: true,
        control,
        connection: "connected",
        connectionRevision: 1,
      },
    },
    devices: {
      [deviceAuthorityKey(adapterName, deviceId)]: {
        read: true,
        control,
      },
    },
    capabilities: {
      [capabilityAuthorityKey(adapterName, deviceId, capabilityId)]: {
        read: true,
        control,
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

class FakeAdapter implements StudioPhysicalCommandAdapter {
  readonly calls: Array<{ lease: ControlLease; power: boolean }> = [];

  dispatchLightPower(
    lease: ControlLease,
    power: boolean,
  ): HomeAssistantControlDispatchResult {
    this.calls.push({ lease, power });
    return {
      status: "dispatched",
      requestId: 44,
    };
  }
}

describe("StudioPhysicalControlController", () => {
  it("issues an application lease before invoking the integration adapter", () => {
    const adapter = new FakeAdapter();
    const controller = new StudioPhysicalControlController(adapter, {
      sessionId: "session:studio",
      authority: () => authority(true),
      now: () => "2026-10-04T16:10:00Z",
      createCommandId: () => "command:fixture",
      createCorrelationId: () => "correlation:fixture",
    });

    expect(controller.setLightPower(deviceId, capabilityId, true)).toEqual({
      status: "dispatched",
      commandId: "command:fixture",
      requestId: 44,
    });

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toMatchObject({
      power: true,
      lease: {
        intent: {
          commandId: "command:fixture",
          correlationId: "correlation:fixture",
          target: "physical",
          adapter: "home-assistant",
          deviceId,
          capabilityId,
          capabilityKind: "light",
          origin: {
            surface: "studio",
            sessionId: "session:studio",
          },
        },
      },
    });
  });

  it("never invokes the integration adapter when physical authority is absent", () => {
    const adapter = new FakeAdapter();
    const controller = new StudioPhysicalControlController(adapter, {
      sessionId: "session:studio",
      authority: () => authority(false),
      now: () => "2026-10-04T16:10:00Z",
      createCommandId: () => "command:denied",
      createCorrelationId: () => "correlation:denied",
    });

    expect(controller.setLightPower(deviceId, capabilityId, false)).toEqual({
      status: "denied",
      commandId: "command:denied",
      reason: "physical-control-not-authorized",
    });
    expect(adapter.calls).toHaveLength(0);
  });

  it("selection or construction alone cannot dispatch a physical command", () => {
    const adapter = new FakeAdapter();

    new StudioPhysicalControlController(adapter, {
      sessionId: "session:studio",
      authority: () => authority(true),
    });

    expect(adapter.calls).toHaveLength(0);
  });
});
