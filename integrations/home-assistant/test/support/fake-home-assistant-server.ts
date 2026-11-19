import {
  SimulatedHomeAssistant,
  syntheticHomeSnapshot,
  type HaRawSnapshot,
  type HaScheduler,
  type HaTransport,
} from "../../src/index.js";

export const FAKE_TOKEN = "fake-test-token";

export interface ReceivedMessage {
  readonly connection: number;
  readonly message: Record<string, unknown>;
}

/**
 * Deterministic in-memory fake of Home Assistant's WebSocket API. It speaks the
 * real message shapes (auth handshake, registries, get_states, subscribe_events,
 * call_service) over an in-process transport. No sockets, no network, no
 * credentials: it only accepts FAKE_TOKEN and only holds synthetic entities.
 */
export class FakeHomeAssistantServer {
  readonly sim: SimulatedHomeAssistant;
  readonly received: ReceivedMessage[] = [];
  connectionCount = 0;

  readonly #open = new Set<FakeConnection>();
  #refuse = 0;
  #failNextServiceCall = false;
  #holdResults = false;
  #held: Array<() => void> = [];

  constructor(snapshot: HaRawSnapshot = syntheticHomeSnapshot()) {
    this.sim = new SimulatedHomeAssistant(snapshot);
  }

  /** Transport factory to hand to the session under test. */
  readonly connect = (): HaTransport => {
    if (this.#refuse > 0) {
      this.#refuse -= 1;
      throw new Error("connection refused (fake)");
    }
    this.connectionCount += 1;
    const connection = new FakeConnection(this, this.connectionCount);
    this.#open.add(connection);
    return connection.transport;
  };

  refuseNextConnections(count: number): void {
    this.#refuse = count;
  }

  /** Drop every open connection, as a network failure would. */
  dropAll(): void {
    for (const connection of [...this.#open]) connection.drop();
  }

  failNextServiceCall(): void {
    this.#failNextServiceCall = true;
  }

  /** Queue results (not events) until releaseResults(), to model slow replies. */
  holdResults(): void {
    this.#holdResults = true;
  }

  releaseResults(): void {
    this.#holdResults = false;
    const held = this.#held;
    this.#held = [];
    for (const fn of held) fn();
  }

  get openConnections(): number {
    return this.#open.size;
  }

  messagesOfType(type: string): ReceivedMessage[] {
    return this.received.filter((m) => m.message["type"] === type);
  }

  /** @internal */
  _closed(connection: FakeConnection): void {
    this.#open.delete(connection);
  }

  /** @internal */
  _record(connection: number, message: Record<string, unknown>): void {
    const safe = message["type"] === "auth" ? { type: "auth" } : message;
    this.received.push({ connection, message: safe });
  }

  /** @internal */
  _takeFailure(): boolean {
    const fail = this.#failNextServiceCall;
    this.#failNextServiceCall = false;
    return fail;
  }

  /** @internal */
  _deliverResult(fn: () => void): void {
    if (this.#holdResults) this.#held.push(fn);
    else fn();
  }
}

class FakeConnection {
  readonly transport: HaTransport;
  readonly #server: FakeHomeAssistantServer;
  readonly #id: number;
  readonly #messageListeners = new Set<(data: string) => void>();
  readonly #closeListeners = new Set<() => void>();
  readonly #queue: string[] = [];
  #authenticated = false;
  #closed = false;
  #unsubscribeSim: (() => void) | null = null;

  constructor(server: FakeHomeAssistantServer, id: number) {
    this.#server = server;
    this.#id = id;
    this.transport = {
      send: (data) => this.#receive(data),
      close: () => this.#close(false),
      onMessage: (listener) => {
        this.#messageListeners.add(listener);
        // Deliver anything queued before the client attached (auth_required).
        queueMicrotask(() => this.#flush());
        return () => this.#messageListeners.delete(listener);
      },
      onClose: (listener) => {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
      },
    };
    this.#emit({ type: "auth_required", ha_version: "fake" });
  }

  drop(): void {
    this.#close(true);
  }

  #close(notify: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeSim?.();
    this.#server._closed(this);
    if (notify) for (const listener of [...this.#closeListeners]) listener();
  }

  #emit(message: unknown): void {
    if (this.#closed) return;
    this.#queue.push(JSON.stringify(message));
    this.#flush();
  }

  #flush(): void {
    if (this.#messageListeners.size === 0) return;
    while (this.#queue.length > 0) {
      const data = this.#queue.shift() as string;
      for (const listener of [...this.#messageListeners]) listener(data);
    }
  }

  #result(id: unknown, result: unknown): void {
    this.#server._deliverResult(() => this.#emit({ id, type: "result", success: true, result }));
  }

  #receive(data: string): void {
    if (this.#closed) throw new Error("fake socket closed");
    const message = JSON.parse(data) as Record<string, unknown>;
    this.#server._record(this.#id, message);
    const id = message["id"];
    const snapshot = this.#server.sim.snapshot();

    if (message["type"] === "auth") {
      if (message["access_token"] === FAKE_TOKEN) {
        this.#authenticated = true;
        this.#emit({ type: "auth_ok", ha_version: "fake" });
      } else {
        this.#emit({ type: "auth_invalid", message: "Invalid access token" });
      }
      return;
    }
    if (!this.#authenticated) return;

    switch (message["type"]) {
      case "config/area_registry/list":
        return this.#result(id, snapshot.areas);
      case "config/device_registry/list":
        return this.#result(id, snapshot.devices);
      case "config/entity_registry/list":
        return this.#result(id, snapshot.entities);
      case "get_states":
        return this.#result(id, snapshot.states);
      case "subscribe_events":
        this.#unsubscribeSim = this.#server.sim.subscribe((event) => {
          this.#emit({
            id,
            type: "event",
            event: {
              event_type: "state_changed",
              data: {
                entity_id: event.entityId,
                old_state: event.oldState,
                new_state: event.newState,
              },
            },
          });
        });
        return this.#result(id, null);
      case "call_service": {
        if (this.#server._takeFailure()) {
          this.#server._deliverResult(() =>
            this.#emit({
              id,
              type: "result",
              success: false,
              error: { code: "home_assistant_error", message: "fake failure" },
            }),
          );
          return;
        }
        const target = (message["target"] ?? {}) as { entity_id?: string };
        const { contextId } = this.#server.sim.callService({
          domain: String(message["domain"]),
          service: String(message["service"]),
          entityId: String(target.entity_id),
          data: (message["service_data"] ?? {}) as Record<string, unknown>,
        });
        return this.#result(id, { context: { id: contextId, parent_id: null, user_id: null } });
      }
      default:
        return this.#server._deliverResult(() =>
          this.#emit({
            id,
            type: "result",
            success: false,
            error: { code: "unknown_command", message: "Unknown command." },
          }),
        );
    }
  }
}

/** Manual clock + timers so reconnect/throttle tests are fully deterministic. */
export class ManualScheduler implements HaScheduler {
  #now = 0;
  #nextHandle = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, { at: this.#now + delayMs, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }

  /** Advance time, firing due timers in order and letting promises settle between. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await settle();
      const due = [...this.#timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.#now = Math.max(this.#now, due[1].at);
      due[1].callback();
    }
    this.#now = target;
    await settle();
  }
}

export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}
