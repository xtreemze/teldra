import { describe, expect, it } from "vitest";
import {
  authorizeControlIntent,
  capabilityAuthorityKey,
  classifyInFlightLoss,
  controlDecisionDiagnostic,
  deviceAuthorityKey,
  revalidateControlLease,
  type ControlAuthoritySnapshot,
  type ControlIntent,
} from "../src/index.js";

const adapter = "home-assistant";
const deviceId = "device:living-room";
const lightCapabilityId = "capability:light";
const climateCapabilityId = "capability:climate";
const openingCapabilityId = "capability:opening";

function snapshot(): ControlAuthoritySnapshot {
  return {
    revision: 7,
    adapters: {
      [adapter]: {
        read: true,
        control: true,
        connection: "connected",
        connectionRevision: 3,
      },
    },
    devices: {
      [deviceAuthorityKey(adapter, deviceId)]: {
        read: true,
        control: true,
      },
    },
    capabilities: {
      [capabilityAuthorityKey(adapter, deviceId, lightCapabilityId)]: {
        read: true,
        control: true,
      },
      [capabilityAuthorityKey(adapter, deviceId, climateCapabilityId)]: {
        read: true,
        control: true,
      },
      [capabilityAuthorityKey(adapter, deviceId, openingCapabilityId)]: {
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

function intent(
  capabilityId: string,
  capabilityKind: ControlIntent["capabilityKind"],
): ControlIntent {
  return {
    commandId: `command:${capabilityKind}`,
    correlationId: "correlation:user-action",
    target: "physical",
    adapter,
    deviceId,
    capabilityId,
    capabilityKind,
    origin: {
      surface: "studio",
      sessionId: "session:studio",
    },
  };
}

describe("smart-home control authorization", () => {
  it("allows read-backed local simulation without physical control authority", () => {
    const state = snapshot();
    const simulated = {
      ...intent(lightCapabilityId, "light"),
      target: "simulation" as const,
    };

    const restricted: ControlAuthoritySnapshot = {
      ...state,
      adapters: {
        [adapter]: {
          ...state.adapters[adapter]!,
          control: false,
          connection: "unavailable",
        },
      },
      devices: {},
      capabilities: {},
    };

    expect(
      authorizeControlIntent(
        restricted,
        simulated,
        "2026-10-04T10:00:00Z",
      ).allowed,
    ).toBe(true);
  });

  it("authorizes low-risk light control only through explicit adapter/device/capability grants", () => {
    const decision = authorizeControlIntent(
      snapshot(),
      intent(lightCapabilityId, "light"),
      "2026-10-04T10:00:00Z",
    );

    expect(decision).toMatchObject({
      allowed: true,
      risk: "low",
      target: "physical",
    });
  });

  it("keeps newly discovered devices read-only until device and capability control are explicitly granted", () => {
    const state = snapshot();
    const newlyDiscovered: ControlAuthoritySnapshot = {
      ...state,
      devices: {},
      capabilities: {},
    };

    expect(
      authorizeControlIntent(
        newlyDiscovered,
        intent(lightCapabilityId, "light"),
        "2026-10-04T10:00:00Z",
      ),
    ).toMatchObject({
      allowed: false,
      reason: "physical-control-not-authorized",
    });
  });

  it("requires active user presence for climate control", () => {
    const state = snapshot();
    const withoutPresence: ControlAuthoritySnapshot = {
      ...state,
      sessions: {
        "session:studio": {
          ...state.sessions["session:studio"]!,
          userPresent: false,
        },
      },
    };

    expect(
      authorizeControlIntent(
        withoutPresence,
        intent(climateCapabilityId, "climate"),
        "2026-10-04T10:00:00Z",
      ),
    ).toMatchObject({
      allowed: false,
      risk: "elevated",
      reason: "user-presence-required",
    });
  });

  it("requires fresh command-bound confirmation for opening control", () => {
    const opening = intent(openingCapabilityId, "opening");

    expect(
      authorizeControlIntent(
        snapshot(),
        opening,
        "2026-10-04T10:00:00Z",
      ),
    ).toMatchObject({
      allowed: false,
      risk: "high",
      reason: "confirmation-required",
    });

    const confirmed: ControlIntent = {
      ...opening,
      confirmation: {
        commandId: opening.commandId,
        risk: "high",
        confirmedAt: "2026-10-04T09:59:55Z",
        expiresAt: "2026-10-04T10:00:10Z",
      },
    };

    expect(
      authorizeControlIntent(
        snapshot(),
        confirmed,
        "2026-10-04T10:00:00Z",
      ),
    ).toMatchObject({
      allowed: true,
      risk: "high",
    });
  });

  it("rejects renderer/embed origins that are not explicitly authorized for the session", () => {
    const embedded: ControlIntent = {
      ...intent(lightCapabilityId, "light"),
      origin: {
        surface: "lit-embed",
        sessionId: "session:studio",
      },
    };

    expect(
      authorizeControlIntent(
        snapshot(),
        embedded,
        "2026-10-04T10:00:00Z",
      ),
    ).toMatchObject({
      allowed: false,
      reason: "origin-not-authorized",
    });
  });

  it("rejects unavailable adapters before issuing a physical lease", () => {
    const state = snapshot();
    const unavailable: ControlAuthoritySnapshot = {
      ...state,
      adapters: {
        [adapter]: {
          ...state.adapters[adapter]!,
          connection: "unavailable",
        },
      },
    };

    expect(
      authorizeControlIntent(
        unavailable,
        intent(lightCapabilityId, "light"),
        "2026-10-04T10:00:00Z",
      ),
    ).toMatchObject({
      allowed: false,
      reason: "adapter-unavailable",
    });
  });

  it("invalidates a lease when authority is revoked before dispatch", () => {
    const state = snapshot();
    const decision = authorizeControlIntent(
      state,
      intent(lightCapabilityId, "light"),
      "2026-10-04T10:00:00Z",
    );

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;

    const revoked: ControlAuthoritySnapshot = {
      ...state,
      revision: state.revision + 1,
      capabilities: {
        ...state.capabilities,
        [capabilityAuthorityKey(adapter, deviceId, lightCapabilityId)]: {
          read: true,
          control: false,
        },
      },
    };

    expect(
      revalidateControlLease(
        revoked,
        decision.lease,
        "2026-10-04T10:00:01Z",
      ),
    ).toMatchObject({
      allowed: false,
      reason: "authority-changed",
    });
  });

  it("invalidates a lease when connectivity changes before dispatch", () => {
    const state = snapshot();
    const decision = authorizeControlIntent(
      state,
      intent(lightCapabilityId, "light"),
      "2026-10-04T10:00:00Z",
    );

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;

    const disconnected: ControlAuthoritySnapshot = {
      ...state,
      adapters: {
        [adapter]: {
          ...state.adapters[adapter]!,
          connection: "disconnected",
          connectionRevision:
            state.adapters[adapter]!.connectionRevision + 1,
        },
      },
    };

    expect(
      revalidateControlLease(
        disconnected,
        decision.lease,
        "2026-10-04T10:00:01Z",
      ),
    ).toMatchObject({
      allowed: false,
      reason: "connection-changed",
    });
  });

  it("marks in-flight physical outcomes unknown instead of automatically retrying after authority/connectivity loss", () => {
    const state = snapshot();
    const decision = authorizeControlIntent(
      state,
      intent(lightCapabilityId, "light"),
      "2026-10-04T10:00:00Z",
    );

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;

    expect(
      classifyInFlightLoss(decision.lease, {
        ...state,
        revision: state.revision + 1,
      }),
    ).toBe("outcome-unknown-do-not-retry");
  });

  it("produces correlation-safe audit diagnostics without credentials", () => {
    const controlIntent = intent(lightCapabilityId, "light");
    const decision = authorizeControlIntent(
      snapshot(),
      controlIntent,
      "2026-10-04T10:00:00Z",
    );

    const diagnostic = controlDecisionDiagnostic(
      "event:authorization",
      "2026-10-04T10:00:00Z",
      controlIntent,
      decision,
    );

    expect(diagnostic.correlationId).toBe(controlIntent.correlationId);
    expect(diagnostic.fields.deviceId).toMatchObject({
      sensitivity: "project-private",
    });
    expect(diagnostic.fields.capabilityId).toMatchObject({
      sensitivity: "project-private",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("token");
    expect(JSON.stringify(diagnostic)).not.toContain("password");
  });
});
