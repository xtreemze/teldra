import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import liveSchema from "@teldra/schemas/live" with { type: "json" };
import type {
  Availability,
  CommandAck,
  DesiredState,
  Observation,
  TeldraLiveEnvelope,
  Values,
} from "@teldra/schemas/types/live";

export type {
  Availability,
  CommandAck,
  DesiredState,
  Observation,
  StateValue,
  TeldraLiveEnvelope,
  Values,
} from "@teldra/schemas/types/live";

export interface LiveEnvelopeIssue {
  source: "schema" | "integrity";
  path: string;
  message: string;
}

export type LiveEnvelopeValidationResult =
  | {
      valid: true;
      value: TeldraLiveEnvelope;
      issues: readonly [];
    }
  | {
      valid: false;
      issues: readonly LiveEnvelopeIssue[];
    };

export type LiveApplyResult =
  | { status: "applied" }
  | { status: "duplicate" }
  | { status: "ignored-older" };

export interface CapabilityRuntimeSnapshot {
  readonly observed?: Observation;
  readonly desired?: DesiredState;
  readonly availability?: Availability;
  readonly commandAck?: CommandAck;
}

export type EffectiveCapabilityValues =
  | {
      source: "desired";
      values: Values;
      commandId: string;
    }
  | {
      source: "observed";
      values: Values;
    }
  | {
      source: "none";
      values: undefined;
    };

export type ObservationFreshness = "fresh" | "stale" | "unknown";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateStructure: ValidateFunction<TeldraLiveEnvelope> =
  ajv.compile<TeldraLiveEnvelope>(liveSchema);

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function validateLiveEnvelope(
  value: unknown,
): LiveEnvelopeValidationResult {
  if (!validateStructure(value)) {
    return {
      valid: false,
      issues: schemaIssues(validateStructure.errors),
    };
  }

  const issues = validateIntegrity(value);
  if (issues.length > 0) {
    return {
      valid: false,
      issues,
    };
  }

  return {
    valid: true,
    value,
    issues: [],
  };
}

export function parseLiveEnvelope(value: unknown): TeldraLiveEnvelope {
  const result = validateLiveEnvelope(value);
  if (!result.valid) {
    throw new LiveEnvelopeError(
      "Invalid Teldra live envelope.",
      result.issues,
    );
  }

  return result.value;
}

export class LiveEnvelopeError extends Error {
  readonly issues: readonly LiveEnvelopeIssue[];

  constructor(message: string, issues: readonly LiveEnvelopeIssue[]) {
    super(message);
    this.name = "LiveEnvelopeError";
    this.issues = issues;
  }
}

export class LiveTwinStore {
  readonly #seenEventIds = new Set<string>();
  readonly #capabilities = new Map<string, MutableCapabilityRuntimeState>();
  readonly #deviceAvailability = new Map<string, Availability>();

  apply(input: unknown): LiveApplyResult {
    const event = parseLiveEnvelope(input);

    if (this.#seenEventIds.has(event.eventId)) {
      return { status: "duplicate" };
    }
    this.#seenEventIds.add(event.eventId);

    switch (event.kind) {
      case "observation":
        return this.#applyObservation(event);
      case "availability":
        return this.#applyAvailability(event);
      case "desired-state":
        return this.#applyDesired(event);
      case "command-ack":
        return this.#applyCommandAck(event);
    }
  }

  getCapability(
    deviceId: string,
    capabilityId: string,
  ): CapabilityRuntimeSnapshot {
    const current = this.#capabilities.get(capabilityKey(deviceId, capabilityId));
    const capabilityAvailability = current?.availability;
    const deviceAvailability = this.#deviceAvailability.get(deviceId);

    return {
      ...(current?.observed === undefined ? {} : { observed: current.observed }),
      ...(current?.desired === undefined ? {} : { desired: current.desired }),
      ...(capabilityAvailability === undefined && deviceAvailability === undefined
        ? {}
        : { availability: capabilityAvailability ?? deviceAvailability }),
      ...(current?.commandAck === undefined
        ? {}
        : { commandAck: current.commandAck }),
    };
  }

  getEffectiveValues(
    deviceId: string,
    capabilityId: string,
    now: string,
  ): EffectiveCapabilityValues {
    const snapshot = this.getCapability(deviceId, capabilityId);
    const desired = snapshot.desired;

    if (
      desired !== undefined &&
      desired.optimistic &&
      !isExpired(desired, now)
    ) {
      return {
        source: "desired",
        values: desired.values,
        commandId: desired.commandId,
      };
    }

    if (snapshot.observed !== undefined) {
      return {
        source: "observed",
        values: snapshot.observed.values,
      };
    }

    return {
      source: "none",
      values: undefined,
    };
  }

  freshness(
    deviceId: string,
    capabilityId: string,
    now: string,
    maxAgeMs: number,
  ): ObservationFreshness {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new RangeError("maxAgeMs must be a finite non-negative number.");
    }

    const observed = this.getCapability(deviceId, capabilityId).observed;
    if (observed === undefined) {
      return "unknown";
    }

    return timestampMs(now) - timestampMs(observed.observedAt) > maxAgeMs
      ? "stale"
      : "fresh";
  }

  #state(deviceId: string, capabilityId: string): MutableCapabilityRuntimeState {
    const key = capabilityKey(deviceId, capabilityId);
    const current = this.#capabilities.get(key);

    if (current !== undefined) {
      return current;
    }

    const created: MutableCapabilityRuntimeState = {};
    this.#capabilities.set(key, created);
    return created;
  }

  #applyObservation(event: Observation): LiveApplyResult {
    const state = this.#state(
      event.subject.deviceId,
      event.subject.capabilityId,
    );

    if (
      state.observed !== undefined &&
      compareObservationOrder(event, state.observed) <= 0
    ) {
      return { status: "ignored-older" };
    }

    state.observed = event;

    if (
      state.desired !== undefined &&
      valuesEqual(state.desired.values, event.values)
    ) {
      state.desired = undefined;
    }

    return { status: "applied" };
  }

  #applyAvailability(event: Availability): LiveApplyResult {
    if (event.subject.capabilityId === undefined) {
      const current = this.#deviceAvailability.get(event.subject.deviceId);
      if (
        current !== undefined &&
        compareTimedEventOrder(event, current) <= 0
      ) {
        return { status: "ignored-older" };
      }

      this.#deviceAvailability.set(event.subject.deviceId, event);
      return { status: "applied" };
    }

    const state = this.#state(
      event.subject.deviceId,
      event.subject.capabilityId,
    );
    if (
      state.availability !== undefined &&
      compareTimedEventOrder(event, state.availability) <= 0
    ) {
      return { status: "ignored-older" };
    }

    state.availability = event;
    return { status: "applied" };
  }

  #applyDesired(event: DesiredState): LiveApplyResult {
    const state = this.#state(
      event.subject.deviceId,
      event.subject.capabilityId,
    );

    if (
      state.desired !== undefined &&
      compareTimestamp(event.requestedAt, state.desired.requestedAt) < 0
    ) {
      return { status: "ignored-older" };
    }

    state.desired = event;
    state.commandAck = undefined;
    return { status: "applied" };
  }

  #applyCommandAck(event: CommandAck): LiveApplyResult {
    const state = this.#state(
      event.subject.deviceId,
      event.subject.capabilityId,
    );

    if (
      state.commandAck !== undefined &&
      state.commandAck.commandId === event.commandId &&
      compareTimestamp(event.receivedAt, state.commandAck.receivedAt) < 0
    ) {
      return { status: "ignored-older" };
    }

    state.commandAck = event;

    if (
      state.desired?.commandId === event.commandId &&
      (event.status === "rejected" || event.status === "failed")
    ) {
      state.desired = undefined;
    }

    return { status: "applied" };
  }
}

interface MutableCapabilityRuntimeState {
  observed?: Observation;
  desired?: DesiredState;
  availability?: Availability;
  commandAck?: CommandAck;
}

function compareObservationOrder(
  next: Observation,
  previous: Observation,
): number {
  if (
    next.source.streamId === previous.source.streamId &&
    next.source.sequence !== undefined &&
    previous.source.sequence !== undefined
  ) {
    return next.source.sequence - previous.source.sequence;
  }

  return compareTimedEventOrder(next, previous);
}

function compareTimedEventOrder(
  next: Pick<Observation | Availability, "observedAt" | "receivedAt">,
  previous: Pick<Observation | Availability, "observedAt" | "receivedAt">,
): number {
  const observed = compareTimestamp(next.observedAt, previous.observedAt);
  return observed !== 0
    ? observed
    : compareTimestamp(next.receivedAt, previous.receivedAt);
}

function compareTimestamp(next: string, previous: string): number {
  return timestampMs(next) - timestampMs(previous);
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new LiveEnvelopeError("Invalid Teldra live timestamp.", [
      {
        source: "integrity",
        path: "",
        message: `Invalid RFC3339 timestamp "${value}".`,
      },
    ]);
  }
  return parsed;
}

function isExpired(desired: DesiredState, now: string): boolean {
  return desired.expiresAt !== undefined &&
    timestampMs(now) >= timestampMs(desired.expiresAt);
}

function valuesEqual(left: Values, right: Values): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }

  return leftKeys.every((key) =>
    JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

function capabilityKey(deviceId: string, capabilityId: string): string {
  return `${deviceId}\u0000${capabilityId}`;
}

function validateIntegrity(
  envelope: TeldraLiveEnvelope,
): readonly LiveEnvelopeIssue[] {
  const issues: LiveEnvelopeIssue[] = [];

  for (const [path, timestamp] of envelopeTimestamps(envelope)) {
    if (!RFC3339.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
      issues.push({
        source: "integrity",
        path,
        message: "Timestamp must be RFC3339 with an explicit timezone.",
      });
    }
  }

  if (
    envelope.kind === "desired-state" &&
    envelope.expiresAt !== undefined &&
    Date.parse(envelope.expiresAt) < Date.parse(envelope.requestedAt)
  ) {
    issues.push({
      source: "integrity",
      path: "/expiresAt",
      message: "Desired-state expiry cannot precede requestedAt.",
    });
  }

  return issues;
}

function envelopeTimestamps(
  envelope: TeldraLiveEnvelope,
): readonly (readonly [path: string, value: string])[] {
  switch (envelope.kind) {
    case "observation":
    case "availability":
      return [
        ["/observedAt", envelope.observedAt],
        ["/receivedAt", envelope.receivedAt],
      ];
    case "desired-state":
      return [
        ["/requestedAt", envelope.requestedAt],
        ...(envelope.expiresAt === undefined
          ? []
          : ([["/expiresAt", envelope.expiresAt]] as const)),
      ];
    case "command-ack":
      return [["/receivedAt", envelope.receivedAt]];
  }
}

function schemaIssues(
  errors: readonly ErrorObject[] | null | undefined,
): readonly LiveEnvelopeIssue[] {
  return (errors ?? []).map((error) => ({
    source: "schema",
    path: error.instancePath,
    message: error.message ?? "JSON Schema validation failed.",
  }));
}
