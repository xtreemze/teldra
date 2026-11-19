import type { IfcAPI } from "web-ifc";
import { SessionCore } from "./session-core.js";

/**
 * Reusable edit session: keeps one web-ifc model open (and its reference index built) across successive
 * operations on the same byte revision, so repeated edits of a large IFC skip re-opening and re-scanning.
 *
 * ```ts
 * let session = openEditSession(api, ifcBytes);
 * const next = session.run((bytes) => duplicateFurniture(api, bytes, guid, newGuid));
 * // session now tracks `next`; chain further edits on it:
 * const after = session.run((bytes) => writeFurniturePose(api, bytes, newGuid, pose));
 * session.close(); // frees the wasm model (also when the revision is abandoned)
 * ```
 *
 * Contract:
 * - Any exported edit/read function of this package works inside `run`; pass it the `bytes` argument
 *   `run` supplies (the current revision). Outside `run`, or with other bytes, functions behave as before
 *   (open, edit, save, close). Results are byte-identical either way.
 * - Revisions are immutable: the session never modifies caller bytes, and callers must not mutate bytes
 *   they handed to a session (a cheap sampled fingerprint rejects obvious in-place edits).
 * - A successful writing operation advances the session to the returned bytes. An operation that throws
 *   after writing discards the open model; the session reopens lazily from the last good revision.
 * - A session holds one wasm model (roughly the file size or more). Call `close()` when done.
 * - Not re-entrant across threads/workers; one session belongs to one `IfcAPI`.
 */
export interface IfcEditSession {
  /** The byte revision the session currently represents. */
  readonly bytes: Uint8Array;
  /** True while a wasm model is held open. */
  readonly isOpen: boolean;
  /** Whether this session already represents exactly `bytes` for `api` (same object identity). */
  matches(api: IfcAPI, bytes: Uint8Array): boolean;
  run<T>(operation: (bytes: Uint8Array) => T): T;
  close(): void;
}

class Session implements IfcEditSession {
  constructor(private readonly core: SessionCore) {}
  get bytes(): Uint8Array { return this.core.bytes; }
  get isOpen(): boolean { return this.core.isOpen; }
  matches(api: IfcAPI, bytes: Uint8Array): boolean { return this.core.matches(api, bytes); }
  run<T>(operation: (bytes: Uint8Array) => T): T { return this.core.scope(() => operation(this.core.bytes)); }
  close(): void { this.core.close(); }
}

/** Opens lazily: the wasm model is created by the first operation. */
export function openEditSession(api: IfcAPI, bytes: Uint8Array): IfcEditSession {
  return new Session(new SessionCore(api, bytes));
}

/**
 * Returns `previous` when it already represents `bytes`; otherwise closes it and opens a session on `bytes`.
 * Convenient for callers holding "the current IFC bytes" in state: pass them each time.
 */
export function reuseEditSession(previous: IfcEditSession | null | undefined, api: IfcAPI, bytes: Uint8Array): IfcEditSession {
  if (previous?.matches(api, bytes)) return previous;
  previous?.close();
  return openEditSession(api, bytes);
}
