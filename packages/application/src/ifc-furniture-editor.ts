import { AffectedElementLog } from "./affected-elements.js";
import { CommandTransactionError, CommandProcessor, type CanonicalCommand, type CommandHistoryStatus, type CommandResolver, type JsonValue } from "./commands.js";
import { validateFurnitureCatalogItem, type FurnitureCatalogItem } from "@teldra/furniture-catalog";
import type { FurnitureSourceDimensions } from "./furniture-dimensions.js";

export interface FurnitureWorldPose { readonly position: readonly [number, number, number]; readonly yawRadians: number }
export type FurnitureGeometryScale = readonly [number, number, number];
export interface IfcFurnitureAdapter {
  read(bytes: Uint8Array, ifcGlobalId: string): FurnitureWorldPose;
  write(bytes: Uint8Array, ifcGlobalId: string, pose: FurnitureWorldPose): Uint8Array;
  /** Optional: only supported per-instance IFC4 mapped geometry. */
  readScale?(bytes: Uint8Array, ifcGlobalId: string): FurnitureGeometryScale;
  writeScale?(bytes: Uint8Array, ifcGlobalId: string, scale: FurnitureGeometryScale): Uint8Array;
  /** Immutable source-provenance nominal dimensions when a SH3D import supplies them. */
  readSourceDimensions?(bytes: Uint8Array, ifcGlobalId: string): FurnitureSourceDimensions | null;
  /** Optional lifecycle: create a catalog furniture occurrence under a caller-supplied IFC GlobalId. Must not mutate `bytes`. */
  insert?(bytes: Uint8Array, request: FurnitureInsertRequest): Uint8Array;
}
/**
 * Catalog insertion. `pose` is world-frame IFC metres (Z up, yaw about Z); the adapter derives
 * storey-relative placement. The catalog item is a resolved, validated snapshot, so replaying the
 * command never depends on a catalog that may since have changed.
 */
export interface FurnitureInsertRequest {
  readonly ifcGlobalId: string;
  readonly storeyGlobalId: string;
  readonly catalogId: string;
  readonly catalogVersion: string;
  readonly item: FurnitureCatalogItem;
  readonly pose: FurnitureWorldPose;
  readonly name?: string;
}
const GLOBAL_ID = /^[0-3][0-9A-Za-z_$]{21}$/;
type PoseCommand = CanonicalCommand<"ifc.furniture.pose", { readonly ifcGlobalId: string; readonly position: readonly [number, number, number]; readonly yawRadians: number }>;
type ScaleCommand = CanonicalCommand<"ifc.furniture.geometry-scale", { readonly ifcGlobalId: string; readonly scale: FurnitureGeometryScale }>;
type TransformCommand = CanonicalCommand<"ifc.furniture.transform", { readonly ifcGlobalId: string; readonly position: readonly [number,number,number]; readonly yawRadians: number; readonly scale: FurnitureGeometryScale }>;
// The catalog snapshot travels as plain JSON so history entries stay serialisable and replayable.
type InsertCommand = CanonicalCommand<"ifc.furniture.insert", { readonly request: JsonValue }>;
type RestoreCommand = CanonicalCommand<"ifc.restore", { readonly snapshot: string }>;
type IfcCommand = InsertCommand | PoseCommand | ScaleCommand | TransformCommand | RestoreCommand;
interface IfcState { readonly bytes: Uint8Array }

/** Canonical IFC mutations pass through an injected IFC-aware adapter and command history. */
export class IfcFurnitureEditor {
  readonly #processor: CommandProcessor<IfcState, IfcCommand>;
  readonly #adapter: IfcFurnitureAdapter;
  #sequence = 0;
  readonly #affected = new AffectedElementLog();
  constructor(bytes: Uint8Array, adapter: IfcFurnitureAdapter) {
    this.#adapter = adapter;
    // Keep binary snapshots as bytes instead of expanding large IFC files into JSON number arrays.
    const snapshots = new Map<string, Uint8Array>();
    const resolve: CommandResolver<IfcState, IfcCommand> = () => (state, command) => {
      const key = `snapshot:${command.id}`;
      snapshots.set(key, state.bytes.slice());
      const next = command.kind === "ifc.furniture.insert"
        ? adapter.insert?.(state.bytes.slice(), command.payload.request as unknown as FurnitureInsertRequest)
        : command.kind === "ifc.furniture.pose"
        ? adapter.write(state.bytes.slice(), command.payload.ifcGlobalId, { position: command.payload.position, yawRadians: command.payload.yawRadians })
        : command.kind === "ifc.furniture.geometry-scale"
          ? adapter.writeScale?.(state.bytes.slice(), command.payload.ifcGlobalId, command.payload.scale)
          : command.kind === "ifc.furniture.transform"
            ? adapter.writeScale?.(
                adapter.write(state.bytes.slice(), command.payload.ifcGlobalId, { position: command.payload.position, yawRadians: command.payload.yawRadians }),
                command.payload.ifcGlobalId, command.payload.scale)
            : snapshots.get(command.payload.snapshot);
      if (!next) throw new Error("IFC history snapshot is unavailable.");
      return { state: { bytes: next.slice() }, inverse: { id: `inverse:${command.id}`, kind: "ifc.restore", authority: "canonical-ifc", payload: { snapshot: key } } };
    };
    this.#processor = new CommandProcessor({ bytes: bytes.slice() }, resolve);
  }
  get bytes(): Uint8Array { return this.#processor.state.bytes.slice(); }
  get history(): CommandHistoryStatus { return this.#processor.history; }
  /** GlobalIds touched by the latest edit/undo/redo; input for derived-scene regeneration. */
  get lastAffectedGlobalIds(): readonly string[] { return this.#affected.last; }
  read(ifcGlobalId: string): FurnitureWorldPose { return this.#adapter.read(this.bytes, ifcGlobalId); }
  readScale(ifcGlobalId: string): FurnitureGeometryScale {
    if (!this.#adapter.readScale) throw new Error("This IFC editor has no mapped-geometry scale adapter.");
    return this.#adapter.readScale(this.bytes, ifcGlobalId);
  }
  transform(ifcGlobalId: string, pose: FurnitureWorldPose, scale: FurnitureGeometryScale): void {
    if (!this.#adapter.writeScale) throw new Error("IFC geometry scaling is unavailable.");
    if (pose.position.length !== 3 || ![...pose.position, pose.yawRadians].every(Number.isFinite) ||
        scale.length !== 3 || scale.some(value => !Number.isFinite(value) || value <= 0 || value > 1000))
      throw new Error("IFC transform requires finite pose and positive geometry factors.");
    this.#sequence++;
    this.#processor.execute({ id: "ifc-transform:" + this.#sequence, commands: [{
      id: "ifc-transform-command:" + this.#sequence, kind: "ifc.furniture.transform",
      authority: "canonical-ifc", payload: { ifcGlobalId, position: pose.position, yawRadians: pose.yawRadians, scale },
    }] });
    this.#affected.recordApply([ifcGlobalId]);
  }
  scale(ifcGlobalId: string, scale: FurnitureGeometryScale): void {
    if (!this.#adapter.writeScale) throw new Error("IFC geometry scaling is unavailable.");
    if (scale.length !== 3 || scale.some(value => !Number.isFinite(value) || value <= 0 || value > 1000))
      throw new Error("Geometry scale must contain three finite, positive factors.");
    this.#sequence++;
    this.#processor.execute({ id: "ifc-scale:" + this.#sequence, commands: [{
      id: "ifc-scale-command:" + this.#sequence, kind: "ifc.furniture.geometry-scale",
      authority: "canonical-ifc", payload: { ifcGlobalId, scale },
    }] });
    this.#affected.recordApply([ifcGlobalId]);
  }
  /**
   * Atomic and reversible: afterwards exactly one new, typed, storey-contained IfcFurniture exists, or
   * nothing changed. Undo restores byte-identical IFC. Affected GlobalIds: the new element.
   */
  insert(request: FurnitureInsertRequest): void {
    if (!this.#adapter.insert) throw new Error("This IFC editor cannot insert furniture.");
    if (!GLOBAL_ID.test(request.ifcGlobalId) || !GLOBAL_ID.test(request.storeyGlobalId))
      throw new Error("Insert requires compressed 22-character IFC GlobalIds for the element and its storey.");
    if (request.pose.position.length !== 3 || ![...request.pose.position, request.pose.yawRadians].every(Number.isFinite))
      throw new Error("Insert requires a finite world pose.");
    const checked = validateFurnitureCatalogItem(request.item);
    if (!checked.valid) throw new Error("Insert requires a valid catalog item: " + checked.issues.map((i) => `${i.path} ${i.message}`).join("; "));
    this.#sequence++;
    this.#explicit(() => this.#processor.execute({ id: "ifc-insert:" + this.#sequence, commands: [{
      id: "ifc-insert-command:" + this.#sequence, kind: "ifc.furniture.insert", authority: "canonical-ifc", payload: { request: request as unknown as JsonValue },
    }] }));
    this.#affected.recordApply([request.ifcGlobalId]); // undo/redo replay this entry so regeneration removes/re-adds the instance
  }
  /** Surface the adapter's explicit refusal instead of the generic transaction wrapper. */
  #explicit(run: () => unknown): void {
    try { run(); }
    catch (error) { throw error instanceof CommandTransactionError && error.cause instanceof Error ? error.cause : error; }
  }
  place(ifcGlobalId: string, pose: FurnitureWorldPose): void {
    this.#sequence++;
    this.#processor.execute({ id: `ifc-pose:${this.#sequence}`, commands: [{ id: `ifc-pose-command:${this.#sequence}`, kind: "ifc.furniture.pose", authority: "canonical-ifc", payload: { ifcGlobalId, position: pose.position, yawRadians: pose.yawRadians } }] });
    this.#affected.recordApply([ifcGlobalId]);
  }
  undo(): boolean { const done = this.#processor.undo() !== null; if (done) this.#affected.recordUndo(); return done; }
  redo(): boolean { const done = this.#processor.redo() !== null; if (done) this.#affected.recordRedo(); return done; }
}
