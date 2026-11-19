/**
 * Minimal Home Assistant WebSocket client with an outgoing-message guard.
 *
 * The guard is the lowest enforcement layer for operating modes: a read-only
 * client cannot emit `call_service` (or any message type outside the read
 * allowlist) no matter which code holds a reference to it.
 */

export interface HaTransport {
  send(data: string): void;
  close(): void;
  onMessage(listener: (data: string) => void): () => void;
  onClose(listener: () => void): () => void;
}

export type HaTransportFactory = () => HaTransport | Promise<HaTransport>;

/** Browser/`ws`-style socket surface needed to build a transport. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", l: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", l: () => void): void;
  removeEventListener(type: "message", l: (event: { data: unknown }) => void): void;
  removeEventListener(type: "close" | "error", l: () => void): void;
}

export function transportFromWebSocket(socket: WebSocketLike): HaTransport {
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onMessage(listener) {
      const wrapped = (event: { data: unknown }) => {
        if (typeof event.data === "string") listener(event.data);
      };
      socket.addEventListener("message", wrapped);
      return () => socket.removeEventListener("message", wrapped);
    },
    onClose(listener) {
      socket.addEventListener("close", listener);
      socket.addEventListener("error", listener);
      return () => {
        socket.removeEventListener("close", listener);
        socket.removeEventListener("error", listener);
      };
    },
  };
}

export class HomeAssistantModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeAssistantModeError";
  }
}

export class HomeAssistantAuthError extends Error {
  constructor() {
    super("Home Assistant rejected the access token.");
    this.name = "HomeAssistantAuthError";
  }
}

/** The connection closed while a request was in flight; its outcome is unknown. */
export class HomeAssistantConnectionLostError extends Error {
  constructor() {
    super("The Home Assistant connection closed before a response arrived.");
    this.name = "HomeAssistantConnectionLostError";
  }
}

export class HomeAssistantRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HomeAssistantRequestError";
  }
}

export type HaClientCapability = "read-only" | "control";

const READ_ONLY_TYPES: ReadonlySet<string> = new Set([
  "auth",
  "ping",
  "get_states",
  "subscribe_events",
  "unsubscribe_events",
  "config/area_registry/list",
  "config/device_registry/list",
  "config/entity_registry/list",
]);

export interface HaRequest {
  readonly type: string;
  readonly [key: string]: unknown;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class HaWsClient {
  readonly #transport: HaTransport;
  readonly #capability: HaClientCapability;
  readonly #pending = new Map<number, Pending>();
  readonly #eventListeners = new Map<number, (event: unknown) => void>();
  readonly #closeListeners = new Set<() => void>();
  readonly #unsubscribers: Array<() => void> = [];
  #nextId = 1;
  #authenticated = false;
  #closed = false;
  #authWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  #pendingToken: string | null = null;
  #authRequired = false;

  constructor(transport: HaTransport, capability: HaClientCapability) {
    this.#transport = transport;
    this.#capability = capability;
    this.#unsubscribers.push(
      transport.onMessage((data) => this.#onMessage(data)),
      transport.onClose(() => this.#onClose()),
    );
  }

  get capability(): HaClientCapability {
    return this.#capability;
  }

  authenticate(accessToken: string): Promise<void> {
    if (accessToken.length === 0) {
      throw new Error("Home Assistant access token must not be empty.");
    }
    this.#pendingToken = accessToken;
    return new Promise<void>((resolve, reject) => {
      this.#authWaiter = { resolve, reject };
      if (this.#authRequired) this.#sendAuth();
    });
  }

  /**
   * Send a request and await its result. Throws synchronously when the message
   * type is not permitted for this client's capability.
   */
  request<T = unknown>(message: HaRequest): Promise<T> {
    this.#assertAllowed(message.type);
    if (this.#closed) {
      return Promise.reject(new HomeAssistantConnectionLostError());
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.#transport.send(JSON.stringify({ ...message, id }));
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("send failed"));
      }
    });
  }

  async subscribeEvents(eventType: string, listener: (event: unknown) => void): Promise<void> {
    this.#assertAllowed("subscribe_events");
    if (this.#closed) throw new HomeAssistantConnectionLostError();
    const id = this.#nextId++;
    this.#eventListeners.set(id, listener);
    await new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#transport.send(JSON.stringify({ id, type: "subscribe_events", event_type: eventType }));
    });
  }

  callService(
    domain: string,
    service: string,
    entityId: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly context?: { readonly id?: string } }> {
    return this.request({
      type: "call_service",
      domain,
      service,
      service_data: data,
      target: { entity_id: entityId },
      return_response: false,
    });
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const off of this.#unsubscribers) off();
    this.#rejectAll();
    try {
      this.#transport.close();
    } catch {
      // Already closed.
    }
  }

  #sendAuth(): void {
    this.#transport.send(JSON.stringify({ type: "auth", access_token: this.#pendingToken }));
  }

  #assertAllowed(type: string): void {
    if (type === "call_service") {
      if (this.#capability !== "control") {
        throw new HomeAssistantModeError(
          "This Home Assistant connection is read-only; call_service is not permitted.",
        );
      }
      return;
    }
    if (!READ_ONLY_TYPES.has(type)) {
      throw new HomeAssistantModeError(`Home Assistant message type "${type}" is not permitted.`);
    }
  }

  #onMessage(data: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message["type"]) {
      case "auth_required":
        this.#authRequired = true;
        if (this.#pendingToken !== null) this.#sendAuth();
        return;
      case "auth_ok":
        this.#authenticated = true;
        this.#pendingToken = null;
        this.#authWaiter?.resolve();
        this.#authWaiter = null;
        return;
      case "auth_invalid":
        this.#pendingToken = null;
        this.#authWaiter?.reject(new HomeAssistantAuthError());
        this.#authWaiter = null;
        return;
      case "result": {
        const id = message["id"];
        if (typeof id !== "number") return;
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        if (message["success"] === true) {
          pending.resolve(message["result"]);
        } else {
          const error = (message["error"] ?? {}) as { code?: unknown; message?: unknown };
          pending.reject(
            new HomeAssistantRequestError(
              typeof error.code === "string" ? error.code : "unknown",
              typeof error.message === "string" ? error.message : "Home Assistant request failed.",
            ),
          );
        }
        return;
      }
      case "event": {
        const id = message["id"];
        if (typeof id === "number") this.#eventListeners.get(id)?.(message["event"]);
        return;
      }
      default:
        return;
    }
  }

  #onClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#authWaiter?.reject(new HomeAssistantConnectionLostError());
    this.#authWaiter = null;
    this.#rejectAll();
    for (const listener of [...this.#closeListeners]) listener();
  }

  #rejectAll(): void {
    for (const pending of this.#pending.values()) {
      pending.reject(new HomeAssistantConnectionLostError());
    }
    this.#pending.clear();
    this.#eventListeners.clear();
  }

  get authenticated(): boolean {
    return this.#authenticated;
  }
}
