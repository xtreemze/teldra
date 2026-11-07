import { CommandProcessor, type CanonicalCommand, type CommandHistoryStatus, type CommandResolver } from "./commands.js";

export interface FurnitureWorldPose { readonly position: readonly [number, number, number]; readonly yawRadians: number }
export type FurnitureGeometryScale = readonly [number, number, number];
export interface IfcFurnitureAdapter {
  read(bytes: Uint8Array, ifcGlobalId: string): FurnitureWorldPose;
  write(bytes: Uint8Array, ifcGlobalId: string, pose: FurnitureWorldPose): Uint8Array;
  /** Optional: only supported per-instance IFC4 mapped geometry. */
  readScale?(bytes: Uint8Array, ifcGlobalId: string): FurnitureGeometryScale;
  writeScale?(bytes: Uint8Array, ifcGlobalId: string, scale: FurnitureGeometryScale): Uint8Array;
}
type PoseCommand = CanonicalCommand<"ifc.furniture.pose", { readonly ifcGlobalId: string; readonly position: readonly [number, number, number]; readonly yawRadians: number }>;
type ScaleCommand = CanonicalCommand<"ifc.furniture.geometry-scale", { readonly ifcGlobalId: string; readonly scale: FurnitureGeometryScale }>;
type TransformCommand = CanonicalCommand<"ifc.furniture.transform", { readonly ifcGlobalId: string; readonly pose: FurnitureWorldPose; readonly scale: FurnitureGeometryScale }>;
type RestoreCommand = CanonicalCommand<"ifc.restore", { readonly snapshot: string }>;
type IfcCommand = PoseCommand | ScaleCommand | TransformCommand | RestoreCommand;
interface IfcState { readonly bytes: Uint8Array }

/** Canonical IFC mutations pass through an injected IFC-aware adapter and command history. */
export class IfcFurnitureEditor {
  readonly #processor: CommandProcessor<IfcState, IfcCommand>;
  readonly #adapter: IfcFurnitureAdapter;
  #sequence = 0;
  constructor(bytes: Uint8Array, adapter: IfcFurnitureAdapter) {
    this.#adapter = adapter;
    // Keep binary snapshots as bytes instead of expanding large IFC files into JSON number arrays.
    const snapshots = new Map<string, Uint8Array>();
    const resolve: CommandResolver<IfcState, IfcCommand> = () => (state, command) => {
      const key = `snapshot:${command.id}`;
      snapshots.set(key, state.bytes.slice());
      const next = command.kind === "ifc.furniture.pose"
        ? adapter.write(state.bytes.slice(), command.payload.ifcGlobalId, { position: command.payload.position, yawRadians: command.payload.yawRadians })
        : command.kind === "ifc.furniture.geometry-scale"
          ? adapter.writeScale?.(state.bytes.slice(), command.payload.ifcGlobalId, command.payload.scale)
          : command.kind === "ifc.furniture.transform"
            ? adapter.writeScale?.(
                adapter.write(state.bytes.slice(), command.payload.ifcGlobalId, command.payload.pose),
                command.payload.ifcGlobalId, command.payload.scale)
            : snapshots.get(command.payload.snapshot);
      if (!next) throw new Error("IFC history snapshot is unavailable.");
      return { state: { bytes: next.slice() }, inverse: { id: `inverse:${command.id}`, kind: "ifc.restore", authority: "canonical-ifc", payload: { snapshot: key } } };
    };
    this.#processor = new CommandProcessor({ bytes: bytes.slice() }, resolve);
  }
  get bytes(): Uint8Array { return this.#processor.state.bytes.slice(); }
  get history(): CommandHistoryStatus { return this.#processor.history; }
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
      authority: "canonical-ifc", payload: { ifcGlobalId, pose, scale },
    }] });
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
  }
  place(ifcGlobalId: string, pose: FurnitureWorldPose): void {
    this.#sequence++;
    this.#processor.execute({ id: `ifc-pose:${this.#sequence}`, commands: [{ id: `ifc-pose-command:${this.#sequence}`, kind: "ifc.furniture.pose", authority: "canonical-ifc", payload: { ifcGlobalId, position: pose.position, yawRadians: pose.yawRadians } }] });
  }
  undo(): boolean { return this.#processor.undo() !== null; }
  redo(): boolean { return this.#processor.redo() !== null; }
}
