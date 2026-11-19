import type { HomeAssistantState } from "./index.js";

export interface HaScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemScheduler: HaScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface BackoffPolicy {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly factor: number;
  /** Fraction of the delay randomized in both directions, 0..1. */
  readonly jitterRatio: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitterRatio: 0.2,
};

/** Delay before reconnect attempt `attempt` (0-based). `random` returns [0,1). */
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const base = Math.min(policy.maxMs, policy.initialMs * policy.factor ** attempt);
  const jitter = (random() * 2 - 1) * policy.jitterRatio * base;
  return Math.max(0, Math.round(Math.min(policy.maxMs, base + jitter)));
}

/**
 * Remembers context ids of Teldra-originated service calls so the resulting
 * `state_changed` events can be recognized as self-echo rather than as an
 * external actor changing the light.
 */
export class EchoTracker {
  readonly #contexts = new Map<string, number>();
  readonly #ttlMs: number;

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  remember(contextId: string, nowMs: number): void {
    this.#contexts.set(contextId, nowMs + this.#ttlMs);
  }

  isOwn(contextId: string | undefined, nowMs: number): boolean {
    this.#prune(nowMs);
    return contextId !== undefined && this.#contexts.has(contextId);
  }

  get size(): number {
    return this.#contexts.size;
  }

  #prune(nowMs: number): void {
    for (const [id, expiresAt] of this.#contexts) {
      if (expiresAt <= nowMs) this.#contexts.delete(id);
    }
  }
}

/** HA's own timestamp for ordering: last_updated, else last_changed. */
export function stateTimestampMs(state: HomeAssistantState): number {
  const parsed = Date.parse(state.last_updated ?? state.last_changed);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * Last-writer-wins by Home Assistant's timestamp: an incoming state strictly
 * older than the stored one is stale (e.g. a reconciliation snapshot racing a
 * newer event) and must not overwrite it.
 */
export function isStale(
  stored: HomeAssistantState | undefined,
  incoming: HomeAssistantState,
): boolean {
  return stored !== undefined && stateTimestampMs(incoming) < stateTimestampMs(stored);
}
