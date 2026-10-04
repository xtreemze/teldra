import {
  privateField,
  publicField,
  type DiagnosticEvent,
} from "@teldra/diagnostics";
import {
  revalidateControlLease,
  type ControlAuthoritySnapshot,
  type ControlDenialReason,
  type ControlLease,
} from "@teldra/control-policy";
import type {
  ExternalBinding,
  TwinCapability,
  TwinProject,
} from "@teldra/domain";
import type {
  TeldraLiveEnvelope,
  Values,
} from "@teldra/live-state";

export interface HomeAssistantState {
  readonly entity_id: string;
  readonly state: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly last_changed: string;
  readonly last_updated?: string;
}

export interface HomeAssistantMessageEvent {
  readonly data: unknown;
}

export interface HomeAssistantWebSocket {
  send(data: string): void;
  addEventListener(
    type: "message",
    listener: (event: HomeAssistantMessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: HomeAssistantMessageEvent) => void,
  ): void;
  close?(): void;
}

export interface HomeAssistantReadAdapterOptions {
  readonly onEnvelope: (envelope: TeldraLiveEnvelope) => void;
  readonly onDiagnostic?: (event: DiagnosticEvent) => void;
  readonly now?: () => string;
}

interface ResolvedBinding {
  readonly binding: ExternalBinding;
  readonly capabilities: readonly TwinCapability[];
}

interface HomeAssistantResultMessage {
  readonly id: number;
  readonly type: "result";
  readonly success: boolean;
  readonly result?: unknown;
}

interface HomeAssistantEventMessage {
  readonly id: number;
  readonly type: "event";
  readonly event: {
    readonly event_type?: string;
    readonly data?: unknown;
    readonly time_fired?: string;
  };
}

type HomeAssistantProtocolMessage =
  | { readonly type: "auth_required" }
  | { readonly type: "auth_ok" }
  | { readonly type: "auth_invalid"; readonly message?: string }
  | HomeAssistantResultMessage
  | HomeAssistantEventMessage;

const HOME_ASSISTANT_ADAPTER = "home-assistant";

export class HomeAssistantReadAdapter {
  readonly #bindings: ReadonlyMap<string, ResolvedBinding>;
  readonly #onEnvelope: (envelope: TeldraLiveEnvelope) => void;
  readonly #onDiagnostic: (event: DiagnosticEvent) => void;
  readonly #now: () => string;

  #nextRequestId = 1;
  #sequence = 0;
  #getStatesRequestId: number | null = null;
  #stateChangedSubscriptionId: number | null = null;
  #diagnosticSequence = 0;

  constructor(
    twin: TwinProject,
    options: HomeAssistantReadAdapterOptions,
  ) {
    this.#bindings = buildBindingIndex(twin);
    this.#onEnvelope = options.onEnvelope;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  attach(
    socket: HomeAssistantWebSocket,
    accessToken: string,
  ): () => void {
    if (accessToken.length === 0) {
      throw new Error("Home Assistant access token must not be empty.");
    }

    const onMessage = (event: HomeAssistantMessageEvent) => {
      this.#handleMessage(socket, accessToken, event.data);
    };

    socket.addEventListener("message", onMessage);

    return () => {
      socket.removeEventListener("message", onMessage);
    };
  }

  ingestState(state: HomeAssistantState): readonly TeldraLiveEnvelope[] {
    const resolved = this.#bindings.get(state.entity_id);
    if (resolved === undefined) {
      this.#diagnostic(
        "debug",
        "home-assistant.state.ignored-unbound",
        "Ignored an unbound Home Assistant entity.",
        this.#now(),
        {
          entityId: privateField(state.entity_id),
        },
      );
      return [];
    }

    const observedAt = state.last_updated ?? state.last_changed;
    if (!validTimestamp(observedAt)) {
      this.#diagnostic(
        "warn",
        "home-assistant.state.invalid-timestamp",
        "Ignored a Home Assistant state with an invalid timestamp.",
        this.#now(),
        {
          entityId: privateField(state.entity_id),
          bindingId: privateField(resolved.binding.id),
        },
      );
      return [];
    }

    return this.#emitState(
      resolved,
      state.entity_id,
      state.state,
      state.attributes,
      observedAt,
    );
  }

  ingestRemovedEntity(
    entityId: string,
    observedAt: string,
  ): readonly TeldraLiveEnvelope[] {
    const resolved = this.#bindings.get(entityId);
    if (resolved === undefined || !validTimestamp(observedAt)) {
      return [];
    }

    const sequence = this.#nextSequence();
    const receivedAt = this.#now();
    const envelopes = resolved.capabilities.map((capability) =>
      availabilityEnvelope(
        resolved.binding,
        capability,
        entityId,
        sequence,
        observedAt,
        receivedAt,
        "unavailable",
      ),
    );

    this.#emit(envelopes);
    return envelopes;
  }

  #handleMessage(
    socket: HomeAssistantWebSocket,
    accessToken: string,
    raw: unknown,
  ): void {
    const message = parseProtocolMessage(raw);
    if (message === null) {
      this.#diagnostic(
        "warn",
        "home-assistant.protocol.invalid-message",
        "Ignored an invalid Home Assistant WebSocket message.",
        this.#now(),
        {},
      );
      return;
    }

    switch (message.type) {
      case "auth_required":
        socket.send(JSON.stringify({
          type: "auth",
          access_token: accessToken,
        }));
        return;

      case "auth_ok": {
        this.#diagnostic(
          "info",
          "home-assistant.connection.authenticated",
          "Home Assistant WebSocket authenticated.",
          this.#now(),
          {},
        );

        const getStatesId = this.#nextRequestId++;
        const subscriptionId = this.#nextRequestId++;
        this.#getStatesRequestId = getStatesId;
        this.#stateChangedSubscriptionId = subscriptionId;

        socket.send(JSON.stringify({
          id: getStatesId,
          type: "get_states",
        }));
        socket.send(JSON.stringify({
          id: subscriptionId,
          type: "subscribe_events",
          event_type: "state_changed",
        }));
        return;
      }

      case "auth_invalid":
        this.#diagnostic(
          "error",
          "home-assistant.connection.auth-invalid",
          "Home Assistant authentication failed.",
          this.#now(),
          {},
        );
        socket.close?.();
        return;

      case "result":
        this.#handleResult(message);
        return;

      case "event":
        this.#handleEvent(message);
        return;
    }
  }

  #handleResult(message: HomeAssistantResultMessage): void {
    if (message.id === this.#getStatesRequestId) {
      if (!message.success || !Array.isArray(message.result)) {
        this.#diagnostic(
          "error",
          "home-assistant.states.initial-fetch-failed",
          "Home Assistant initial state fetch failed.",
          this.#now(),
          {},
        );
        return;
      }

      for (const candidate of message.result) {
        const state = parseState(candidate);
        if (state !== null) {
          this.ingestState(state);
        }
      }

      this.#diagnostic(
        "info",
        "home-assistant.states.initial-fetch-complete",
        "Home Assistant initial state snapshot was processed.",
        this.#now(),
        {
          stateCount: publicField(message.result.length),
        },
      );
      return;
    }

    if (message.id === this.#stateChangedSubscriptionId) {
      this.#diagnostic(
        message.success ? "info" : "error",
        message.success
          ? "home-assistant.states.subscription-active"
          : "home-assistant.states.subscription-failed",
        message.success
          ? "Home Assistant state-change subscription is active."
          : "Home Assistant state-change subscription failed.",
        this.#now(),
        {},
      );
    }
  }

  #handleEvent(message: HomeAssistantEventMessage): void {
    if (
      message.id !== this.#stateChangedSubscriptionId ||
      message.event.event_type !== "state_changed" ||
      !isRecord(message.event.data)
    ) {
      return;
    }

    const entityId = message.event.data.entity_id;
    if (typeof entityId !== "string" || entityId.length === 0) {
      return;
    }

    const state = parseState(message.event.data.new_state);
    if (state !== null) {
      this.ingestState(state);
      return;
    }

    if (message.event.data.new_state === null) {
      const observedAt = message.event.time_fired;
      if (typeof observedAt === "string") {
        this.ingestRemovedEntity(entityId, observedAt);
      }
    }
  }

  #emitState(
    resolved: ResolvedBinding,
    entityId: string,
    state: string,
    attributes: Readonly<Record<string, unknown>>,
    observedAt: string,
  ): readonly TeldraLiveEnvelope[] {
    const sequence = this.#nextSequence();
    const receivedAt = this.#now();

    if (state === "unavailable" || state === "unknown") {
      const status = state === "unavailable" ? "unavailable" : "unknown";
      const envelopes = resolved.capabilities.map((capability) =>
        availabilityEnvelope(
          resolved.binding,
          capability,
          entityId,
          sequence,
          observedAt,
          receivedAt,
          status,
        ),
      );
      this.#emit(envelopes);
      return envelopes;
    }

    const envelopes: TeldraLiveEnvelope[] = [];

    for (const capability of resolved.capabilities) {
      envelopes.push(
        availabilityEnvelope(
          resolved.binding,
          capability,
          entityId,
          sequence,
          observedAt,
          receivedAt,
          "online",
        ),
      );

      const values = mapCapabilityValues(capability, state, attributes);
      if (values !== null) {
        envelopes.push(
          observationEnvelope(
            resolved.binding,
            capability,
            entityId,
            sequence,
            observedAt,
            receivedAt,
            values,
          ),
        );
      }
    }

    this.#emit(envelopes);
    return envelopes;
  }

  #emit(envelopes: readonly TeldraLiveEnvelope[]): void {
    for (const envelope of envelopes) {
      this.#onEnvelope(envelope);
    }
  }

  #nextSequence(): number {
    const current = this.#sequence;
    this.#sequence += 1;
    return current;
  }

  #diagnostic(
    level: DiagnosticEvent["level"],
    code: string,
    userMessage: string,
    timestamp: string,
    fields: DiagnosticEvent["fields"],
  ): void {
    this.#diagnosticSequence += 1;

    this.#onDiagnostic({
      schemaVersion: "0.1.0",
      eventId: `ha:diagnostic:${this.#diagnosticSequence}`,
      timestamp,
      level,
      subsystem: "home-assistant",
      code,
      correlationId: "home-assistant:read-adapter",
      userMessage,
      fields,
    });
  }
}


export interface HomeAssistantControlAdapterOptions {
  readonly authority: () => ControlAuthoritySnapshot;
  readonly onEnvelope: (envelope: TeldraLiveEnvelope) => void;
  readonly onDiagnostic?: (event: DiagnosticEvent) => void;
  readonly now?: () => string;
  readonly requestIdStart?: number;
}

export type HomeAssistantControlDispatchResult =
  | {
      readonly status: "dispatched";
      readonly requestId: number;
    }
  | {
      readonly status: "denied";
      readonly reason: ControlDenialReason | "not-attached" | "unsupported-control";
    };

interface PendingHomeAssistantCommand {
  readonly lease: ControlLease;
  readonly binding: ExternalBinding;
  readonly desiredPower: boolean;
}

export class HomeAssistantControlAdapter {
  readonly #bindings: ReadonlyMap<string, ResolvedBinding>;
  readonly #authority: () => ControlAuthoritySnapshot;
  readonly #onEnvelope: (envelope: TeldraLiveEnvelope) => void;
  readonly #onDiagnostic: (event: DiagnosticEvent) => void;
  readonly #now: () => string;
  readonly #pending = new Map<number, PendingHomeAssistantCommand>();

  #socket: HomeAssistantWebSocket | null = null;
  #detach: (() => void) | null = null;
  #nextRequestId: number;
  #sequence = 0;
  #diagnosticSequence = 0;

  constructor(
    twin: TwinProject,
    options: HomeAssistantControlAdapterOptions,
  ) {
    this.#bindings = buildBindingIndex(twin);
    this.#authority = options.authority;
    this.#onEnvelope = options.onEnvelope;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nextRequestId = options.requestIdStart ?? 1_000_000;
  }

  attach(socket: HomeAssistantWebSocket): () => void {
    this.#detach?.();
    this.#socket = socket;

    const onMessage = (event: HomeAssistantMessageEvent) => {
      const message = parseProtocolMessage(event.data);
      if (message?.type === "result") {
        this.#handleResult(message);
      }
    };

    socket.addEventListener("message", onMessage);

    const detach = () => {
      socket.removeEventListener("message", onMessage);
      if (this.#socket === socket) {
        this.#socket = null;
      }
      if (this.#detach === detach) {
        this.#detach = null;
      }
    };

    this.#detach = detach;
    return detach;
  }

  dispatchLightPower(
    lease: ControlLease,
    power: boolean,
  ): HomeAssistantControlDispatchResult {
    const now = this.#now();

    if (
      lease.intent.target !== "physical" ||
      lease.intent.adapter !== HOME_ASSISTANT_ADAPTER ||
      lease.intent.capabilityKind !== "light"
    ) {
      return this.#deny(lease, "unsupported-control", now);
    }

    const revalidated = revalidateControlLease(
      this.#authority(),
      lease,
      now,
    );
    if (!revalidated.allowed) {
      return this.#deny(lease, revalidated.reason, now);
    }

    const resolved = this.#resolveCapability(
      lease.intent.deviceId,
      lease.intent.capabilityId,
    );
    if (resolved === null || entityDomain(resolved.binding.externalId) !== "light") {
      return this.#deny(lease, "unsupported-control", now);
    }

    const socket = this.#socket;
    if (socket === null) {
      return this.#deny(lease, "not-attached", now);
    }

    const requestId = this.#nextRequestId++;
    const desired = desiredLightPowerEnvelope(
      lease,
      power,
      now,
      addMilliseconds(now, 15_000),
    );

    this.#onEnvelope(desired);
    this.#pending.set(requestId, {
      lease,
      binding: resolved.binding,
      desiredPower: power,
    });

    try {
      socket.send(JSON.stringify({
        id: requestId,
        type: "call_service",
        domain: "light",
        service: power ? "turn_on" : "turn_off",
        target: {
          entity_id: resolved.binding.externalId,
        },
        return_response: false,
      }));
    } catch (error) {
      this.#pending.delete(requestId);
      this.#onEnvelope(commandAckEnvelope(
        lease,
        resolved.binding,
        this.#nextSequence(),
        this.#now(),
        "failed",
        "Home Assistant command dispatch failed before the service call was sent.",
      ));
      this.#diagnostic(
        "error",
        "home-assistant.command.dispatch-failed",
        "The Home Assistant command could not be sent.",
        lease,
        {
          reason: publicField(error instanceof Error ? error.name : "unknown-error"),
        },
      );
      return {
        status: "denied",
        reason: "not-attached",
      };
    }

    this.#diagnostic(
      "info",
      "home-assistant.command.dispatched",
      "The Home Assistant light command was dispatched.",
      lease,
      {
        entityId: privateField(resolved.binding.externalId),
        service: publicField(power ? "turn_on" : "turn_off"),
        requestId: publicField(requestId),
      },
    );

    return {
      status: "dispatched",
      requestId,
    };
  }

  #handleResult(message: HomeAssistantResultMessage): void {
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(message.id);

    const timestamp = this.#now();
    const status = message.success ? "completed" : "failed";

    this.#onEnvelope(commandAckEnvelope(
      pending.lease,
      pending.binding,
      this.#nextSequence(),
      timestamp,
      status,
      message.success
        ? "Home Assistant completed the service action."
        : "Home Assistant rejected or failed the service action.",
    ));

    this.#diagnostic(
      message.success ? "info" : "error",
      message.success
        ? "home-assistant.command.completed"
        : "home-assistant.command.failed",
      message.success
        ? "The Home Assistant command completed."
        : "The Home Assistant command failed.",
      pending.lease,
      {
        entityId: privateField(pending.binding.externalId),
        requestId: publicField(message.id),
        desiredPower: publicField(pending.desiredPower),
      },
    );
  }

  #resolveCapability(
    deviceId: string,
    capabilityId: string,
  ): ResolvedBinding | null {
    for (const resolved of this.#bindings.values()) {
      if (
        resolved.binding.deviceId === deviceId &&
        resolved.capabilities.some((capability) => capability.id === capabilityId)
      ) {
        return resolved;
      }
    }
    return null;
  }

  #deny(
    lease: ControlLease,
    reason: ControlDenialReason | "not-attached" | "unsupported-control",
    timestamp: string,
  ): HomeAssistantControlDispatchResult {
    const resolved = this.#resolveCapability(
      lease.intent.deviceId,
      lease.intent.capabilityId,
    );

    if (resolved !== null) {
      this.#onEnvelope(commandAckEnvelope(
        lease,
        resolved.binding,
        this.#nextSequence(),
        timestamp,
        "rejected",
        `Home Assistant command was not dispatched: ${reason}.`,
      ));
    }

    this.#diagnostic(
      "warn",
      "home-assistant.command.denied",
      "The Home Assistant command was not dispatched.",
      lease,
      {
        reason: publicField(reason),
      },
    );

    return {
      status: "denied",
      reason,
    };
  }

  #nextSequence(): number {
    const current = this.#sequence;
    this.#sequence += 1;
    return current;
  }

  #diagnostic(
    level: DiagnosticEvent["level"],
    code: string,
    userMessage: string,
    lease: ControlLease,
    fields: DiagnosticEvent["fields"],
  ): void {
    this.#diagnosticSequence += 1;

    this.#onDiagnostic({
      schemaVersion: "0.1.0",
      eventId: `ha:control-diagnostic:${this.#diagnosticSequence}`,
      timestamp: this.#now(),
      level,
      subsystem: "home-assistant",
      code,
      correlationId: lease.intent.correlationId,
      operationId: lease.intent.commandId,
      userMessage,
      fields: {
        ...fields,
        deviceId: privateField(lease.intent.deviceId),
        capabilityId: privateField(lease.intent.capabilityId),
      },
    });
  }
}

function desiredLightPowerEnvelope(
  lease: ControlLease,
  power: boolean,
  requestedAt: string,
  expiresAt: string,
): TeldraLiveEnvelope {
  return {
    schemaVersion: "0.1.0",
    kind: "desired-state",
    eventId: `control:${lease.intent.commandId}:desired`,
    commandId: lease.intent.commandId,
    subject: {
      deviceId: lease.intent.deviceId,
      capabilityId: lease.intent.capabilityId,
    },
    requestedAt,
    expiresAt,
    values: {
      power: {
        kind: "boolean",
        value: power,
      },
    },
    optimistic: true,
  };
}

function commandAckEnvelope(
  lease: ControlLease,
  binding: ExternalBinding,
  sequence: number,
  receivedAt: string,
  status: "rejected" | "completed" | "failed",
  message: string,
): TeldraLiveEnvelope {
  return {
    schemaVersion: "0.1.0",
    kind: "command-ack",
    eventId: `control:${lease.intent.commandId}:ack:${sequence}`,
    commandId: lease.intent.commandId,
    subject: {
      deviceId: lease.intent.deviceId,
      capabilityId: lease.intent.capabilityId,
    },
    source: {
      adapter: HOME_ASSISTANT_ADAPTER,
      bindingId: binding.id,
      streamId: `ha:command:${binding.externalId}`,
      sequence,
    },
    receivedAt,
    status,
    message,
  };
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid timestamp "${timestamp}".`);
  }
  return new Date(parsed + milliseconds).toISOString();
}

export function buildBindingIndex(
  twin: TwinProject,
): ReadonlyMap<string, ResolvedBinding> {
  const devices = new Map(twin.devices.map((device) => [device.id, device] as const));
  const result = new Map<string, ResolvedBinding>();

  for (const binding of twin.bindings) {
    if (binding.adapter !== HOME_ASSISTANT_ADAPTER) {
      continue;
    }

    const device = devices.get(binding.deviceId);
    if (device === undefined || binding.capabilityMap === undefined) {
      continue;
    }

    const domain = entityDomain(binding.externalId);
    const mappedCapabilityIds = Object.entries(binding.capabilityMap)
      .filter(([, externalCapability]) => externalCapability === domain)
      .map(([capabilityId]) => capabilityId);

    const capabilities = device.capabilities.filter((capability) =>
      mappedCapabilityIds.includes(capability.id),
    );

    if (capabilities.length > 0) {
      result.set(binding.externalId, {
        binding,
        capabilities,
      });
    }
  }

  return result;
}

function mapCapabilityValues(
  capability: TwinCapability,
  state: string,
  attributes: Readonly<Record<string, unknown>>,
): Values | null {
  if (capability.kind !== "light") {
    return null;
  }

  const values: Record<string, Values[string]> = {
    power: {
      kind: "boolean",
      value: state === "on",
    },
  };

  const brightness = numericAttribute(attributes.brightness, 0, 255);
  if (brightness !== null) {
    values.brightness = {
      kind: "number",
      value: brightness / 255,
      unit: "ratio",
    };
  }

  const rgb = rgbAttribute(attributes.rgb_color);
  if (rgb !== null) {
    values.color = {
      kind: "rgb",
      value: [
        rgb[0] / 255,
        rgb[1] / 255,
        rgb[2] / 255,
      ],
    };
  }

  return values;
}

function availabilityEnvelope(
  binding: ExternalBinding,
  capability: TwinCapability,
  entityId: string,
  sequence: number,
  observedAt: string,
  receivedAt: string,
  status: "online" | "unavailable" | "unknown",
): TeldraLiveEnvelope {
  return {
    schemaVersion: "0.1.0",
    kind: "availability",
    eventId: `ha:${binding.id}:${capability.id}:${sequence}:availability`,
    subject: {
      deviceId: binding.deviceId,
      capabilityId: capability.id,
    },
    source: {
      adapter: HOME_ASSISTANT_ADAPTER,
      bindingId: binding.id,
      streamId: `ha:${entityId}`,
      sequence,
    },
    observedAt,
    receivedAt,
    status,
  };
}

function observationEnvelope(
  binding: ExternalBinding,
  capability: TwinCapability,
  entityId: string,
  sequence: number,
  observedAt: string,
  receivedAt: string,
  values: Values,
): TeldraLiveEnvelope {
  return {
    schemaVersion: "0.1.0",
    kind: "observation",
    eventId: `ha:${binding.id}:${capability.id}:${sequence}:observation`,
    subject: {
      deviceId: binding.deviceId,
      capabilityId: capability.id,
    },
    source: {
      adapter: HOME_ASSISTANT_ADAPTER,
      bindingId: binding.id,
      streamId: `ha:${entityId}`,
      sequence,
    },
    observedAt,
    receivedAt,
    values,
  };
}

function parseProtocolMessage(raw: unknown): HomeAssistantProtocolMessage | null {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null;
  }

  switch (parsed.type) {
    case "auth_required":
      return { type: "auth_required" };
    case "auth_ok":
      return { type: "auth_ok" };
    case "auth_invalid":
      return {
        type: "auth_invalid",
        ...(typeof parsed.message === "string"
          ? { message: parsed.message }
          : {}),
      };
    case "result":
      if (
        typeof parsed.id !== "number" ||
        typeof parsed.success !== "boolean"
      ) {
        return null;
      }
      return {
        id: parsed.id,
        type: "result",
        success: parsed.success,
        ...(Object.prototype.hasOwnProperty.call(parsed, "result")
          ? { result: parsed.result }
          : {}),
      };
    case "event":
      if (
        typeof parsed.id !== "number" ||
        !isRecord(parsed.event)
      ) {
        return null;
      }
      return {
        id: parsed.id,
        type: "event",
        event: {
          ...(typeof parsed.event.event_type === "string"
            ? { event_type: parsed.event.event_type }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(parsed.event, "data")
            ? { data: parsed.event.data }
            : {}),
          ...(typeof parsed.event.time_fired === "string"
            ? { time_fired: parsed.event.time_fired }
            : {}),
        },
      };
    default:
      return null;
  }
}

function parseState(value: unknown): HomeAssistantState | null {
  if (
    !isRecord(value) ||
    typeof value.entity_id !== "string" ||
    typeof value.state !== "string" ||
    !isRecord(value.attributes) ||
    typeof value.last_changed !== "string"
  ) {
    return null;
  }

  return {
    entity_id: value.entity_id,
    state: value.state,
    attributes: value.attributes,
    last_changed: value.last_changed,
    ...(typeof value.last_updated === "string"
      ? { last_updated: value.last_updated }
      : {}),
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function entityDomain(entityId: string): string {
  const index = entityId.indexOf(".");
  return index < 0 ? entityId : entityId.slice(0, index);
}

function numericAttribute(
  value: unknown,
  min: number,
  max: number,
): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

function rgbAttribute(value: unknown): readonly [number, number, number] | null {
  if (
    !Array.isArray(value) ||
    value.length !== 3
  ) {
    return null;
  }

  const components = value.map((component) =>
    numericAttribute(component, 0, 255),
  );

  if (components.some((component) => component === null)) {
    return null;
  }

  return [
    components[0] as number,
    components[1] as number,
    components[2] as number,
  ];
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
