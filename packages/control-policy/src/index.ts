import {
  privateField,
  publicField,
  type DiagnosticEvent,
} from "@teldra/diagnostics";
import type { CapabilityKind } from "@teldra/domain";

export type ControlTarget = "simulation" | "physical";

export type ControlOrigin =
  | "studio"
  | "lit-embed"
  | "home-assistant-panel"
  | "cli"
  | "automation";

export type ControlRisk = "low" | "elevated" | "high";

export type AdapterConnectionStatus =
  | "connected"
  | "disconnected"
  | "degraded"
  | "unavailable";

export interface ScopeAuthority {
  readonly read: boolean;
  readonly control: boolean;
}

export interface AdapterAuthority extends ScopeAuthority {
  readonly connection: AdapterConnectionStatus;
  readonly connectionRevision: number;
}

export interface ControlSessionAuthority {
  readonly sessionId: string;
  readonly allowedOrigins: readonly ControlOrigin[];
  readonly userPresent: boolean;
}

export interface ControlAuthoritySnapshot {
  readonly revision: number;
  readonly adapters: Readonly<Record<string, AdapterAuthority>>;
  readonly devices: Readonly<Record<string, ScopeAuthority>>;
  readonly capabilities: Readonly<Record<string, ScopeAuthority>>;
  readonly sessions: Readonly<Record<string, ControlSessionAuthority>>;
}

export interface ControlOriginContext {
  readonly surface: ControlOrigin;
  readonly sessionId: string;
}

export interface ControlConfirmation {
  readonly commandId: string;
  readonly risk: "high";
  readonly confirmedAt: string;
  readonly expiresAt: string;
}

export interface ControlIntent {
  readonly commandId: string;
  readonly correlationId: string;
  readonly target: ControlTarget;
  readonly adapter: string;
  readonly deviceId: string;
  readonly capabilityId: string;
  readonly capabilityKind: CapabilityKind;
  readonly origin: ControlOriginContext;
  readonly confirmation?: ControlConfirmation;
}

export type ControlDenialReason =
  | "read-authority-required"
  | "physical-control-not-authorized"
  | "adapter-unavailable"
  | "origin-not-authorized"
  | "user-presence-required"
  | "confirmation-required"
  | "confirmation-invalid"
  | "authority-changed"
  | "connection-changed";

export type ControlDecision =
  | {
      readonly allowed: true;
      readonly risk: ControlRisk;
      readonly target: ControlTarget;
      readonly lease: ControlLease;
    }
  | {
      readonly allowed: false;
      readonly risk: ControlRisk;
      readonly target: ControlTarget;
      readonly reason: ControlDenialReason;
    };

export interface ControlLease {
  readonly intent: ControlIntent;
  readonly risk: ControlRisk;
  readonly authorityRevision: number;
  readonly adapterConnectionRevision: number;
  readonly issuedAt: string;
}

export type InFlightLossDisposition =
  | "continue-observing"
  | "outcome-unknown-do-not-retry";

export function deviceAuthorityKey(adapter: string, deviceId: string): string {
  return JSON.stringify([adapter, deviceId]);
}

export function capabilityAuthorityKey(
  adapter: string,
  deviceId: string,
  capabilityId: string,
): string {
  return JSON.stringify([adapter, deviceId, capabilityId]);
}

export function riskForCapability(kind: CapabilityKind): ControlRisk {
  switch (kind) {
    case "opening":
      return "high";
    case "climate":
      return "elevated";
    case "light":
    case "media":
    case "switch":
    case "sensor":
      return "low";
  }
}

export function authorizeControlIntent(
  snapshot: ControlAuthoritySnapshot,
  intent: ControlIntent,
  now: string,
): ControlDecision {
  assertIntent(intent);
  timestampMs(now);

  const risk = riskForCapability(intent.capabilityKind);
  const adapter = snapshot.adapters[intent.adapter];

  if (adapter === undefined || !adapter.read) {
    return denied(intent, risk, "read-authority-required");
  }

  if (intent.target === "simulation") {
    return allowed(snapshot, adapter, intent, risk, now);
  }

  if (adapter.connection !== "connected") {
    return denied(intent, risk, "adapter-unavailable");
  }

  const device = snapshot.devices[deviceAuthorityKey(intent.adapter, intent.deviceId)];
  const capability =
    snapshot.capabilities[
      capabilityAuthorityKey(
        intent.adapter,
        intent.deviceId,
        intent.capabilityId,
      )
    ];

  if (
    !adapter.control ||
    device?.control !== true ||
    capability?.control !== true
  ) {
    return denied(intent, risk, "physical-control-not-authorized");
  }

  const session = snapshot.sessions[intent.origin.sessionId];
  if (
    session === undefined ||
    !session.allowedOrigins.includes(intent.origin.surface)
  ) {
    return denied(intent, risk, "origin-not-authorized");
  }

  if (risk === "elevated" && !session.userPresent) {
    return denied(intent, risk, "user-presence-required");
  }

  if (risk === "high") {
    if (!session.userPresent) {
      return denied(intent, risk, "user-presence-required");
    }

    if (intent.confirmation === undefined) {
      return denied(intent, risk, "confirmation-required");
    }

    if (!validConfirmation(intent, now)) {
      return denied(intent, risk, "confirmation-invalid");
    }
  }

  return allowed(snapshot, adapter, intent, risk, now);
}

export function revalidateControlLease(
  snapshot: ControlAuthoritySnapshot,
  lease: ControlLease,
  now: string,
): ControlDecision {
  if (snapshot.revision !== lease.authorityRevision) {
    return {
      allowed: false,
      risk: lease.risk,
      target: lease.intent.target,
      reason: "authority-changed",
    };
  }

  const adapter = snapshot.adapters[lease.intent.adapter];
  if (
    adapter === undefined ||
    adapter.connectionRevision !== lease.adapterConnectionRevision
  ) {
    return {
      allowed: false,
      risk: lease.risk,
      target: lease.intent.target,
      reason: "connection-changed",
    };
  }

  return authorizeControlIntent(snapshot, lease.intent, now);
}

export function classifyInFlightLoss(
  lease: ControlLease,
  snapshot: ControlAuthoritySnapshot,
): InFlightLossDisposition {
  if (lease.intent.target !== "physical") {
    return "continue-observing";
  }

  const adapter = snapshot.adapters[lease.intent.adapter];
  if (
    snapshot.revision !== lease.authorityRevision ||
    adapter === undefined ||
    adapter.connectionRevision !== lease.adapterConnectionRevision ||
    adapter.connection !== "connected"
  ) {
    return "outcome-unknown-do-not-retry";
  }

  return "continue-observing";
}

export function controlDecisionDiagnostic(
  eventId: string,
  timestamp: string,
  intent: ControlIntent,
  decision: ControlDecision,
): DiagnosticEvent {
  return {
    schemaVersion: "0.1.0",
    eventId,
    timestamp,
    level: decision.allowed ? "info" : "warn",
    subsystem: "security",
    code: decision.allowed
      ? "physical-control.authorized"
      : "physical-control.denied",
    correlationId: intent.correlationId,
    operationId: intent.commandId,
    userMessage: decision.allowed
      ? "The device command was authorized."
      : "The device command was not authorized.",
    detail: decision.allowed
      ? "Application control policy issued a command lease."
      : `Application control policy denied the command: ${decision.reason}.`,
    fields: {
      target: publicField(intent.target),
      adapter: publicField(intent.adapter),
      capabilityKind: publicField(intent.capabilityKind),
      risk: publicField(decision.risk),
      result: publicField(decision.allowed ? "allowed" : decision.reason),
      deviceId: privateField(intent.deviceId),
      capabilityId: privateField(intent.capabilityId),
      sessionId: privateField(intent.origin.sessionId),
      origin: publicField(intent.origin.surface),
    },
  };
}

function allowed(
  snapshot: ControlAuthoritySnapshot,
  adapter: AdapterAuthority,
  intent: ControlIntent,
  risk: ControlRisk,
  now: string,
): ControlDecision {
  return {
    allowed: true,
    risk,
    target: intent.target,
    lease: {
      intent,
      risk,
      authorityRevision: snapshot.revision,
      adapterConnectionRevision: adapter.connectionRevision,
      issuedAt: now,
    },
  };
}

function denied(
  intent: ControlIntent,
  risk: ControlRisk,
  reason: ControlDenialReason,
): ControlDecision {
  return {
    allowed: false,
    risk,
    target: intent.target,
    reason,
  };
}

function validConfirmation(intent: ControlIntent, now: string): boolean {
  const confirmation = intent.confirmation;
  if (
    confirmation === undefined ||
    confirmation.commandId !== intent.commandId ||
    confirmation.risk !== "high"
  ) {
    return false;
  }

  const nowMs = timestampMs(now);
  const confirmedAt = timestampMs(confirmation.confirmedAt);
  const expiresAt = timestampMs(confirmation.expiresAt);

  return confirmedAt <= nowMs && nowMs <= expiresAt && confirmedAt <= expiresAt;
}

function assertIntent(intent: ControlIntent): void {
  for (const [name, value] of Object.entries({
    commandId: intent.commandId,
    correlationId: intent.correlationId,
    adapter: intent.adapter,
    deviceId: intent.deviceId,
    capabilityId: intent.capabilityId,
    sessionId: intent.origin.sessionId,
  })) {
    if (value.trim().length === 0) {
      throw new Error(`${name} must not be empty.`);
    }
  }
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid timestamp "${value}".`);
  }
  return parsed;
}
