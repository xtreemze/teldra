import { AffectedElementLog } from "./affected-elements.js";
import { CommandProcessor, type CanonicalCommand, type CommandHistoryStatus, type CommandResolver } from "./commands.js";

/**
 * Canonical IFC wall authoring use case (ADR 0014 / ADR 0023 amendment).
 *
 * All coordinates are IFC world metres, Z up. The editor owns only validation,
 * preview, atomic apply and history; IFC reads/writes are delegated to an injected
 * IFC-aware adapter (packages/ifc-edit). Snapshots of canonical IFC bytes back the
 * inverse command, so undo restores byte-identical content and never regenerates
 * IFC GlobalIds. Renderer, camera, selection and drag state are never inputs.
 */
export type IfcWallGeometry = {
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
  readonly thickness: number;
  readonly height: number;
  readonly elevation: number;
};
export interface IfcWallConnection { readonly wallGlobalId: string; readonly end: "start" | "end"; readonly otherEnd: "start" | "end" }
export interface IfcWallRecord extends IfcWallGeometry { readonly connections: readonly IfcWallConnection[] }
export interface IfcWallChange {
  readonly globalId: string;
  readonly kind: "created" | "updated" | "removed";
  readonly cause: "requested" | "connected";
  readonly before: IfcWallGeometry | null;
  readonly after: IfcWallGeometry | null;
}
export type IfcWallOperation =
  | { readonly kind: "update"; readonly globalId: string; readonly geometry: IfcWallGeometry }
  | { readonly kind: "create"; readonly globalId: string; readonly storeyGlobalId: string; readonly name: string; readonly geometry: IfcWallGeometry }
  | { readonly kind: "remove"; readonly globalId: string };
export interface IfcWallPreview { readonly operations: readonly IfcWallOperation[]; readonly changes: readonly IfcWallChange[] }

export interface IfcWallAdapter {
  read(bytes: Uint8Array, globalId: string): IfcWallRecord;
  /** Non-mutating dry run; throws an explicit error when the edit is unsupported. */
  plan(bytes: Uint8Array, operation: IfcWallOperation): readonly IfcWallChange[];
  /** Returns new IFC bytes; must not mutate its input. */
  apply(bytes: Uint8Array, operation: IfcWallOperation): Uint8Array;
}

export type IfcWallEditErrorCode = "invalid-geometry" | "invalid-global-id" | "invalid-name" | "empty-batch";
export class IfcWallEditError extends Error {
  readonly code: IfcWallEditErrorCode;
  constructor(code: IfcWallEditErrorCode, message: string) { super(message); this.name = "IfcWallEditError"; this.code = code; }
}

/** Mirrors the writer's bounds so Studio can reject early; the adapter re-validates at the IFC boundary. */
export const IFC_WALL_LIMITS = Object.freeze({ minLength: 1e-3, maxLength: 10_000, maxThickness: 100, maxHeight: 100, maxElevation: 10_000 });
const GUID = /^[0-3][0-9A-Za-z_$]{21}$/;

export function validateIfcWallGeometry(geometry: IfcWallGeometry): void {
  const { start, end } = geometry ?? ({} as IfcWallGeometry);
  if (!Array.isArray(start) || !Array.isArray(end) || start.length !== 2 || end.length !== 2)
    throw new IfcWallEditError("invalid-geometry", "Wall endpoints must be 2D metre coordinates.");
  if (![...start, ...end, geometry.thickness, geometry.height, geometry.elevation].every((v) => typeof v === "number" && Number.isFinite(v)))
    throw new IfcWallEditError("invalid-geometry", "Wall coordinates and dimensions must be finite numbers.");
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (length < IFC_WALL_LIMITS.minLength || length > IFC_WALL_LIMITS.maxLength)
    throw new IfcWallEditError("invalid-geometry", `Wall length must be ${IFC_WALL_LIMITS.minLength}..${IFC_WALL_LIMITS.maxLength} m.`);
  if (!(geometry.thickness > 0 && geometry.thickness <= IFC_WALL_LIMITS.maxThickness))
    throw new IfcWallEditError("invalid-geometry", "Wall thickness must be positive and bounded.");
  if (!(geometry.height > 0 && geometry.height <= IFC_WALL_LIMITS.maxHeight))
    throw new IfcWallEditError("invalid-geometry", "Wall height must be positive and bounded.");
  if (Math.abs(geometry.elevation) > IFC_WALL_LIMITS.maxElevation)
    throw new IfcWallEditError("invalid-geometry", "Wall elevation is outside supported bounds.");
}
export function validateIfcWallOperation(op: IfcWallOperation): void {
  const guid = (value: unknown, label: string) => {
    if (typeof value !== "string" || !GUID.test(value)) throw new IfcWallEditError("invalid-global-id", `${label} must be a 22-character IFC GlobalId.`);
  };
  guid(op.globalId, "Wall GlobalId");
  if (op.kind === "remove") return;
  validateIfcWallGeometry(op.geometry);
  if (op.kind === "create") {
    guid(op.storeyGlobalId, "Storey GlobalId");
    if (typeof op.name !== "string" || !op.name.trim() || op.name.length > 256)
      throw new IfcWallEditError("invalid-name", "Wall name must contain 1-256 nonblank characters.");
  }
}

type WallCommand = CanonicalCommand<"ifc.wall.operation", { readonly operation: IfcWallOperation }>;
type RestoreCommand = CanonicalCommand<"ifc.restore", { readonly snapshot: string }>;
type IfcCommand = WallCommand | RestoreCommand;
interface IfcState { readonly bytes: Uint8Array }

/**
 * Validate -> preview -> atomic apply for canonical IFC wall edits. Same history shape
 * as {@link IfcFurnitureEditor} (`ifc.restore` inverse), so both can later be merged
 * into one Studio project history.
 */
export class IfcWallEditor {
  readonly #processor: CommandProcessor<IfcState, IfcCommand>;
  readonly #adapter: IfcWallAdapter;
  #sequence = 0;
  readonly #affected = new AffectedElementLog();
  constructor(bytes: Uint8Array, adapter: IfcWallAdapter) {
    this.#adapter = adapter;
    const snapshots = new Map<string, Uint8Array>();
    const resolve: CommandResolver<IfcState, IfcCommand> = () => (state, command) => {
      const key = `snapshot:${command.id}`;
      snapshots.set(key, state.bytes.slice());
      const next = command.kind === "ifc.wall.operation"
        ? adapter.apply(state.bytes.slice(), command.payload.operation)
        : snapshots.get(command.payload.snapshot);
      if (!next) throw new Error("IFC history snapshot is unavailable.");
      return { state: { bytes: next.slice() }, inverse: { id: `inverse:${command.id}`, kind: "ifc.restore", authority: "canonical-ifc", payload: { snapshot: key } } };
    };
    this.#processor = new CommandProcessor({ bytes: bytes.slice() }, resolve);
  }
  get bytes(): Uint8Array { return this.#processor.state.bytes.slice(); }
  get history(): CommandHistoryStatus { return this.#processor.history; }
  /** GlobalIds touched by the latest apply/undo/redo; input for derived-scene regeneration. */
  get lastAffectedGlobalIds(): readonly string[] { return this.#affected.last; }
  read(globalId: string): IfcWallRecord { return this.#adapter.read(this.bytes, globalId); }

  /** Validates and dry-runs one operation; never mutates bytes or history. */
  preview(operation: IfcWallOperation): IfcWallPreview {
    validateIfcWallOperation(operation);
    return { operations: [operation], changes: this.#adapter.plan(this.bytes, operation) };
  }
  /**
   * Validates every operation, then applies them as one transaction (one undo unit).
   * If any operation fails nothing is published and history is unchanged.
   */
  apply(operations: IfcWallOperation | readonly IfcWallOperation[]): IfcWallPreview {
    const list = Array.isArray(operations) ? (operations as readonly IfcWallOperation[]) : [operations as IfcWallOperation];
    if (!list.length) throw new IfcWallEditError("empty-batch", "At least one wall operation is required.");
    for (const op of list) validateIfcWallOperation(op);
    // Dry-run the whole batch on a scratch copy: later operations depend on earlier results, and
    // refusals surface before any history entry exists.
    const changes: IfcWallChange[] = [];
    let scratch = this.bytes;
    for (const op of list) { changes.push(...this.#adapter.plan(scratch, op)); scratch = this.#adapter.apply(scratch, op); }
    this.#sequence++;
    const n = this.#sequence;
    this.#processor.execute({
      id: `ifc-wall:${n}`,
      commands: list.map((operation, index) => ({
        id: `ifc-wall-command:${n}:${index}`, kind: "ifc.wall.operation" as const, authority: "canonical-ifc" as const, payload: { operation },
      })),
    });
    this.#affected.recordApply(changes.map((change) => change.globalId));
    return { operations: list, changes };
  }
  undo(): boolean { const done = this.#processor.undo() !== null; if (done) this.#affected.recordUndo(); return done; }
  redo(): boolean { const done = this.#processor.redo() !== null; if (done) this.#affected.recordRedo(); return done; }
}
