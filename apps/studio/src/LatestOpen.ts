/**
 * Serializes "open a project" requests by recency. Every request gets a generation; starting a newer one aborts
 * the older one's signal, and an older request that still completes is reported as superseded and its result is
 * disposed instead of replacing what the user asked for last (last-requested wins, not last-completed).
 */
export type LatestOpenOutcome<T> =
  | { readonly status: "current"; readonly value: T }
  | { readonly status: "superseded" };

export interface LatestOpen<T> {
  /** Starts a request. Older in-flight requests are aborted and will resolve as superseded. */
  start(load: (signal: AbortSignal) => Promise<T>): Promise<LatestOpenOutcome<T>>;
  /**
   * Waits for the user to choose something (a file picker) WITHOUT touching in-flight requests, then starts a
   * request for that choice. If choosing rejects (cancelled), the gate and any in-flight request are untouched.
   */
  startAfterChoice<C>(choose: () => Promise<C>, load: (choice: C, signal: AbortSignal) => Promise<T>): Promise<LatestOpenOutcome<T>>;
  /** True while the most recently started request has not settled. */
  pending(): boolean;
  /** Supersedes everything in flight, e.g. when the owner is disposed. */
  cancelAll(): void;
}

export function createLatestOpen<T>(
  dispose: (stale: T) => void | Promise<void>,
  onPendingChange: (pending: boolean) => void = () => {},
): LatestOpen<T> {
  let generation = 0;
  let controller: AbortController | undefined;
  let pending = false;
  const setPending = (next: boolean) => {
    if (pending === next) return;
    pending = next;
    onPendingChange(next);
  };
  const api: LatestOpen<T> = {
    pending: () => pending,
    async startAfterChoice(choose, load) {
      const choice = await choose();
      return api.start(signal => load(choice, signal));
    },
    cancelAll() {
      generation += 1;
      controller?.abort();
      controller = undefined;
      setPending(false);
    },
    async start(load) {
      const mine = ++generation;
      controller?.abort();
      const own = new AbortController();
      controller = own;
      setPending(true);
      const settle = () => {
        if (generation === mine) { controller = undefined; setPending(false); }
      };
      let value: T;
      try {
        value = await load(own.signal);
      } catch (cause) {
        const current = generation === mine;
        settle();
        if (!current) return { status: "superseded" };
        throw cause;
      }
      if (generation !== mine) {
        try { await dispose(value); } catch { /* a stale project failing to close must not affect the current one */ }
        return { status: "superseded" };
      }
      settle();
      return { status: "current", value };
    },
   };
  return api;
}
