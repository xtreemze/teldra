import {
  revalidateControlLease,
  type ControlAuthoritySnapshot,
  type ControlDenialReason,
  type ControlLease,
} from "@teldra/control-policy";
import type { TwinProject } from "@teldra/domain";
import {
  HaWsClient,
  HomeAssistantAuthError,
  HomeAssistantConnectionLostError,
  HomeAssistantModeError,
  type HaTransportFactory,
} from "./client.js";
import {
  simulationGateway,
  webSocketGateway,
  type HaGateway,
} from "./gateway.js";
import { buildBindingIndex } from "./index.js";
import {
  normalizeInventory,
  type HaInventory,
  type HaLight,
  type HaRawSnapshot,
} from "./inventory.js";
import {
  validateLightRequest,
  type HaLightRequest,
  type HaLightRequestErrorCode,
  type HaRequestAdjustment,
} from "./light-capabilities.js";
import {
  SimulatedHomeAssistant,
  type HaStateChangedEvent,
  type HaStateWithContext,
} from "./simulation.js";
import {
  DEFAULT_BACKOFF,
  EchoTracker,
  backoffDelayMs,
  isStale,
  systemScheduler,
  type BackoffPolicy,
  type HaScheduler,
} from "./sync-primitives.js";

const HOME_ASSISTANT_ADAPTER = "home-assistant";

/**
 * simulation:    in-memory store only; no transport is ever created.
 * live-monitor:  read-only connection; any command throws.
 * live-control:  commands allowed only with ADR 0018 leases, revalidated at send.
 */
export type HaOperatingMode = "simulation" | "live-monitor" | "live-control";

export type HaSessionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "auth-failed"
  | "stopped";

/** Where a light-state change came from. */
export type HaStateOrigin = "external" | "teldra-echo" | "reconcile";

export type HaSessionEvent =
  | {
      readonly type: "status";
      readonly status: HaSessionStatus;
      readonly attempt?: number;
      readonly retryInMs?: number;
    }
  | { readonly type: "inventory"; readonly inventory: HaInventory }
  | {
      readonly type: "light-state";
      readonly entityId: string;
      readonly state: string;
      readonly origin: HaStateOrigin;
      readonly simulated: boolean;
      readonly light: HaLight | undefined;
    }
  | { readonly type: "entity-removed"; readonly entityId: string }
  | {
      readonly type: "reconciled";
      readonly reason: "initial" | "reconnect";
      readonly added: readonly string[];
      readonly changed: readonly string[];
      readonly removed: readonly string[];
    };

export type HaCommandOutcome =
  | {
      readonly status: "completed";
      readonly simulated: boolean;
      readonly contextId: string | null;
      readonly adjustments: readonly HaRequestAdjustment[];
    }
  | {
      readonly status: "rejected";
      readonly error: { readonly code: HaLightRequestErrorCode; readonly message: string };
    }
  | {
      readonly status: "denied";
      readonly reason:
        | ControlDenialReason
        | "lease-required"
        | "lease-entity-mismatch"
        | "not-connected";
    }
  | { readonly status: "coalesced"; readonly supersededBy: string }
  | { readonly status: "failed"; readonly message: string }
  /** Connection lost after the call may have been sent. Never auto-retried. */
  | { readonly status: "outcome-unknown" }
  /** Waiting command discarded because the connection was lost or the session stopped. */
  | { readonly status: "dropped" };

export interface HomeAssistantSyncOptions {
  readonly mode?: HaOperatingMode;
  readonly onEvent: (event: HaSessionEvent) => void;
  /** Simulation store. Defaults to an empty one. */
  readonly simulation?: SimulatedHomeAssistant;
  /** Required for live modes. Never invoked in simulation. */
  readonly connect?: HaTransportFactory;
  /** Host-secure token supplier. The token is never stored or emitted. */
  readonly accessToken?: () => string;
  /** Required for live-control. */
  readonly authority?: () => ControlAuthoritySnapshot;
  /** Required for live-control: resolves leases to bound Home Assistant entities. */
  readonly twin?: TwinProject;
  readonly scheduler?: HaScheduler;
  readonly random?: () => number;
  readonly backoff?: BackoffPolicy;
  /** Minimum spacing between service calls for one entity. Default 250 ms. */
  readonly minCommandIntervalMs?: number;
  /** How long a Teldra context id is remembered for echo matching. Default 60 s. */
  readonly echoTtlMs?: number;
}

interface CommandEntry {
  readonly commandId: string;
  readonly entityId: string;
  readonly service: "turn_on" | "turn_off";
  readonly data: Readonly<Record<string, unknown>>;
  readonly adjustments: readonly HaRequestAdjustment[];
  readonly lease: ControlLease | null;
  readonly resolve: (outcome: HaCommandOutcome) => void;
}

interface Lane {
  lastSentAt: number | null;
  trailing: CommandEntry | null;
  timer: unknown;
}

interface InFlight {
  readonly targets: ReadonlySet<string>;
}

interface Deferred {
  readonly entityId: string;
  readonly state: HaStateWithContext;
}

export function createHomeAssistantSyncSession(
  options: HomeAssistantSyncOptions,
): HomeAssistantSyncSession {
  return new HomeAssistantSyncSession(options);
}

export class HomeAssistantSyncSession {
  readonly mode: HaOperatingMode;

  readonly #options: HomeAssistantSyncOptions;
  readonly #scheduler: HaScheduler;
  readonly #random: () => number;
  readonly #backoff: BackoffPolicy;
  readonly #interval: number;
  readonly #echo: EchoTracker;
  readonly #simulation: SimulatedHomeAssistant | null;
  readonly #bindings: ReturnType<typeof buildBindingIndex>;
  readonly #states = new Map<string, HaStateWithContext>();
  readonly #lanes = new Map<string, Lane>();
  readonly #inFlight = new Set<InFlight>();
  readonly #deferred: Deferred[] = [];

  #registries: Omit<HaRawSnapshot, "states"> = { areas: [], devices: [], entities: [] };
  #inventory: HaInventory | null = null;
  #gateway: HaGateway | null = null;
  #status: HaSessionStatus | null = null;
  #generation = 0;
  #attempt = 0;
  #everConnected = false;
  #retryTimer: unknown = null;

  constructor(options: HomeAssistantSyncOptions) {
    this.mode = options.mode ?? "simulation";
    this.#options = options;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#random = options.random ?? Math.random;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#interval = options.minCommandIntervalMs ?? 250;
    this.#echo = new EchoTracker(options.echoTtlMs ?? 60_000);

    if (this.mode === "simulation") {
      this.#simulation = options.simulation ?? new SimulatedHomeAssistant();
    } else {
      this.#simulation = null;
      if (options.connect === undefined || options.accessToken === undefined) {
        throw new HomeAssistantModeError(`${this.mode} requires a transport factory and access token.`);
      }
    }

    if (this.mode === "live-control") {
      if (options.authority === undefined || options.twin === undefined) {
        throw new HomeAssistantModeError("live-control requires an authority snapshot source and a twin.");
      }
      if (options.authority().adapters[HOME_ASSISTANT_ADAPTER]?.control !== true) {
        throw new HomeAssistantModeError("live-control requires an explicit adapter control grant (ADR 0018).");
      }
    }
    this.#bindings = options.twin === undefined ? new Map() : buildBindingIndex(options.twin);
  }

  get status(): HaSessionStatus | null {
    return this.#status;
  }

  inventory(): HaInventory {
    this.#inventory ??= normalizeInventory({
      ...this.#registries,
      states: [...this.#states.values()],
    });
    return this.#inventory;
  }

  light(entityId: string): HaLight | undefined {
    return this.inventory().lights.find((l) => l.entityId === entityId);
  }

  async start(): Promise<void> {
    this.#generation += 1;
    this.#setStatus("connecting");
    if (this.#simulation !== null) {
      this.#gateway = simulationGateway(this.#simulation);
      await this.#bootstrap(this.#gateway, "initial");
      this.#setStatus("connected");
      return;
    }
    await this.#tryConnect();
  }

  stop(): void {
    this.#generation += 1;
    if (this.#retryTimer !== null) this.#scheduler.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#dropWaitingCommands();
    this.#flushAllDeferred();
    const gateway = this.#gateway;
    this.#gateway = null;
    gateway?.close();
    this.#setStatus("stopped");
  }

  /**
   * Validate, throttle and send a light command.
   *
   * Throws in live-monitor mode. In live-control the caller must supply an
   * application-issued lease, which is revalidated at the moment of sending.
   */
  sendLightCommand(
    entityId: string,
    request: HaLightRequest,
    lease?: ControlLease,
  ): Promise<HaCommandOutcome> {
    if (this.mode === "live-monitor") {
      throw new HomeAssistantModeError("Commands are not permitted in live-monitor mode.");
    }

    const light = this.light(entityId);
    if (light === undefined) {
      return Promise.resolve({
        status: "rejected",
        error: { code: "unknown-entity", message: `Unknown light "${entityId}".` },
      });
    }
    const validation = validateLightRequest(light, request);
    if (!validation.ok) {
      return Promise.resolve({ status: "rejected", error: validation.error });
    }

    let activeLease: ControlLease | null = null;
    if (this.mode === "live-control") {
      if (lease === undefined) {
        return Promise.resolve({ status: "denied", reason: "lease-required" });
      }
      if (this.#leaseEntity(lease) !== entityId) {
        return Promise.resolve({ status: "denied", reason: "lease-entity-mismatch" });
      }
      if (this.#gateway === null) {
        return Promise.resolve({ status: "denied", reason: "not-connected" });
      }
      activeLease = lease;
    }

    return new Promise<HaCommandOutcome>((resolve) => {
      this.#enqueue({
        commandId: activeLease?.intent.commandId ?? `simulation:${entityId}:${this.#scheduler.now()}`,
        entityId,
        service: validation.service,
        data: validation.serviceData,
        adjustments: validation.adjustments,
        lease: activeLease,
        resolve,
      });
    });
  }

  // ------------------------------------------------------------- connection

  async #tryConnect(): Promise<void> {
    const generation = this.#generation;
    let client: HaWsClient | null = null;
    try {
      const factory = this.#options.connect as HaTransportFactory;
      const transport = await factory();
      if (generation !== this.#generation) {
        transport.close();
        return;
      }
      client = new HaWsClient(transport, this.mode === "live-control" ? "control" : "read-only");
      await client.authenticate((this.#options.accessToken as () => string)());
      if (generation !== this.#generation) {
        client.close();
        return;
      }
      const gateway = webSocketGateway(client);
      this.#gateway = gateway;
      await this.#bootstrap(gateway, this.#everConnected ? "reconnect" : "initial");
      if (generation !== this.#generation) return;
      this.#everConnected = true;
      this.#attempt = 0;
      gateway.onClose(() => this.#onConnectionLost(generation, gateway));
      this.#setStatus("connected");
    } catch (error) {
      client?.close();
      if (generation !== this.#generation) return;
      this.#gateway = null;
      if (error instanceof HomeAssistantAuthError) {
        // Retrying a rejected token would only hammer the server.
        this.#setStatus("auth-failed");
        return;
      }
      this.#scheduleRetry(generation);
    }
  }

  #onConnectionLost(generation: number, gateway: HaGateway): void {
    if (generation !== this.#generation || this.#gateway !== gateway) return;
    this.#gateway = null;
    this.#dropWaitingCommands();
    this.#flushAllDeferred();
    this.#scheduleRetry(generation);
  }

  #scheduleRetry(generation: number): void {
    const retryInMs = backoffDelayMs(this.#attempt, this.#backoff, this.#random);
    this.#attempt += 1;
    this.#setStatus("reconnecting", { attempt: this.#attempt, retryInMs });
    this.#retryTimer = this.#scheduler.setTimeout(() => {
      this.#retryTimer = null;
      if (generation === this.#generation) void this.#tryConnect();
    }, retryInMs);
  }

  /** Subscribe first, then snapshot, so no change is missed; timestamps order the overlap. */
  async #bootstrap(gateway: HaGateway, reason: "initial" | "reconnect"): Promise<void> {
    await gateway.subscribeStateChanged((event) => this.#onStateChanged(event));
    const snapshot = await gateway.fetchSnapshot();
    this.#applySnapshot(snapshot, reason);
  }

  #applySnapshot(snapshot: HaRawSnapshot, reason: "initial" | "reconnect"): void {
    this.#registries = {
      areas: snapshot.areas,
      devices: snapshot.devices,
      entities: snapshot.entities,
    };
    const incoming = new Map(
      snapshot.states.filter((s) => isTracked(s.entity_id)).map((s) => [s.entity_id, s] as const),
    );

    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];
    for (const [entityId, state] of incoming) {
      const stored = this.#states.get(entityId);
      if (stored === undefined) {
        added.push(entityId);
      } else if (isStale(stored, state)) {
        continue; // a newer event already arrived; last writer wins
      } else if (!sameState(stored, state)) {
        changed.push(entityId);
      }
      this.#states.set(entityId, state);
    }
    for (const entityId of [...this.#states.keys()]) {
      if (!incoming.has(entityId)) {
        this.#states.delete(entityId);
        removed.push(entityId);
      }
    }
    this.#inventory = null;

    for (const entityId of [...added, ...changed].sort()) {
      const state = this.#states.get(entityId);
      if (state !== undefined && entityId.startsWith("light.")) {
        this.#emitLight(entityId, state.state, "reconcile");
      }
    }
    this.#emit({
      type: "reconciled",
      reason,
      added: added.sort(),
      changed: changed.sort(),
      removed: removed.sort(),
    });
    this.#emit({ type: "inventory", inventory: this.inventory() });
  }

  // ------------------------------------------------------------ state events

  #onStateChanged(event: HaStateChangedEvent): void {
    const { entityId, newState } = event;
    if (!isTracked(entityId)) return;

    if (newState === null) {
      if (this.#states.delete(entityId)) {
        this.#inventory = null;
        this.#emit({ type: "entity-removed", entityId });
        this.#emit({ type: "inventory", inventory: this.inventory() });
      }
      return;
    }
    if (isStale(this.#states.get(entityId), newState)) return;

    this.#states.set(entityId, newState);
    this.#inventory = null;

    if (!entityId.startsWith("light.")) {
      this.#emit({ type: "inventory", inventory: this.inventory() });
      return;
    }
    const contextId = newState.context?.id;
    if (this.#echo.isOwn(contextId, this.#scheduler.now())) {
      this.#emitLight(entityId, newState.state, "teldra-echo");
    } else if (this.#affectedByInFlight(entityId)) {
      // The call result (which carries our context id) may not have arrived yet.
      this.#deferred.push({ entityId, state: newState });
    } else {
      this.#emitLight(entityId, newState.state, "external");
    }
  }

  #affectedByInFlight(entityId: string): boolean {
    for (const flight of this.#inFlight) {
      if (flight.targets.has(entityId)) return true;
    }
    return false;
  }

  #flushDeferred(): void {
    const remaining: Deferred[] = [];
    for (const item of this.#deferred.splice(0)) {
      if (this.#echo.isOwn(item.state.context?.id, this.#scheduler.now())) {
        this.#emitLight(item.entityId, item.state.state, "teldra-echo");
      } else if (this.#affectedByInFlight(item.entityId)) {
        remaining.push(item);
      } else {
        this.#emitLight(item.entityId, item.state.state, "external");
      }
    }
    this.#deferred.push(...remaining);
  }

  #flushAllDeferred(): void {
    this.#inFlight.clear();
    this.#flushDeferred();
  }

  #emitLight(entityId: string, state: string, origin: HaStateOrigin): void {
    this.#emit({
      type: "light-state",
      entityId,
      state,
      origin,
      simulated: this.mode === "simulation",
      light: this.light(entityId),
    });
  }

  // --------------------------------------------------------------- commands

  #leaseEntity(lease: ControlLease): string | null {
    const intent = lease.intent;
    if (
      intent.target !== "physical" ||
      intent.adapter !== HOME_ASSISTANT_ADAPTER ||
      intent.capabilityKind !== "light"
    ) {
      return null;
    }
    for (const resolved of this.#bindings.values()) {
      if (
        resolved.binding.deviceId === intent.deviceId &&
        resolved.capabilities.some((c) => c.id === intent.capabilityId)
      ) {
        return resolved.binding.externalId;
      }
    }
    return null;
  }

  #enqueue(entry: CommandEntry): void {
    const lane = this.#lanes.get(entry.entityId) ?? { lastSentAt: null, trailing: null, timer: null };
    this.#lanes.set(entry.entityId, lane);
    const now = this.#scheduler.now();

    if (lane.lastSentAt === null || now - lane.lastSentAt >= this.#interval) {
      this.#transmit(lane, entry);
      return;
    }

    // Within the throttle window: latest command wins.
    if (lane.trailing !== null) {
      lane.trailing.resolve({ status: "coalesced", supersededBy: entry.commandId });
    }
    lane.trailing = entry;
    if (lane.timer === null) {
      lane.timer = this.#scheduler.setTimeout(() => {
        lane.timer = null;
        const next = lane.trailing;
        lane.trailing = null;
        if (next !== null) this.#transmit(lane, next);
      }, lane.lastSentAt + this.#interval - now);
    }
  }

  #transmit(lane: Lane, entry: CommandEntry): void {
    lane.lastSentAt = this.#scheduler.now();
    void this.#execute(entry).then(entry.resolve);
  }

  async #execute(entry: CommandEntry): Promise<HaCommandOutcome> {
    const gateway = this.#gateway;
    if (gateway === null) return { status: "denied", reason: "not-connected" };

    if (this.mode === "live-control" && entry.lease !== null) {
      const authority = (this.#options.authority as () => ControlAuthoritySnapshot)();
      const decision = revalidateControlLease(
        authority,
        entry.lease,
        new Date(this.#scheduler.now()).toISOString(),
      );
      if (!decision.allowed) return { status: "denied", reason: decision.reason };
    }

    const light = this.light(entry.entityId);
    const flight: InFlight = { targets: new Set([entry.entityId, ...(light?.memberEntityIds ?? [])]) };
    this.#inFlight.add(flight);
    try {
      const { contextId } = await gateway.callService({
        domain: "light",
        service: entry.service,
        entityId: entry.entityId,
        data: entry.data,
      });
      if (contextId !== null) this.#echo.remember(contextId, this.#scheduler.now());
      return {
        status: "completed",
        simulated: this.mode === "simulation",
        contextId,
        adjustments: entry.adjustments,
      };
    } catch (error) {
      if (error instanceof HomeAssistantConnectionLostError) return { status: "outcome-unknown" };
      return {
        status: "failed",
        message: error instanceof Error ? error.message : "Home Assistant service call failed.",
      };
    } finally {
      this.#inFlight.delete(flight);
      this.#flushDeferred();
    }
  }

  #dropWaitingCommands(): void {
    for (const lane of this.#lanes.values()) {
      if (lane.timer !== null) this.#scheduler.clearTimeout(lane.timer);
      lane.timer = null;
      lane.trailing?.resolve({ status: "dropped" });
      lane.trailing = null;
    }
  }

  #setStatus(
    status: HaSessionStatus,
    extra: { readonly attempt?: number; readonly retryInMs?: number } = {},
  ): void {
    this.#status = status;
    this.#emit({ type: "status", status, ...extra });
  }

  #emit(event: HaSessionEvent): void {
    this.#options.onEvent(event);
  }
}

function isTracked(entityId: string): boolean {
  return (
    entityId.startsWith("light.") ||
    entityId.startsWith("scene.") ||
    entityId.startsWith("switch.adaptive_lighting_")
  );
}

function sameState(a: HaStateWithContext, b: HaStateWithContext): boolean {
  return a.state === b.state && JSON.stringify(a.attributes) === JSON.stringify(b.attributes);
}
