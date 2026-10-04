import {
  privateField,
  publicField,
  type DiagnosticEvent,
} from "@teldra/diagnostics";
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
