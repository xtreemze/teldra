import { CommandProcessor, type CanonicalCommand, type CommandHistoryStatus, type CommandResolver } from "./commands.js";

export interface FurnitureWorldPose { readonly position: readonly [number, number, number]; readonly yawRadians: number; readonly uniformScale?: number }
export interface IfcFurnitureAdapter {
  read(bytes: Uint8Array, ifcGlobalId: string): FurnitureWorldPose;
  write(bytes: Uint8Array, ifcGlobalId: string, pose: FurnitureWorldPose): Uint8Array;
}
type PoseCommand = CanonicalCommand<"ifc.furniture.pose", { readonly ifcGlobalId: string; readonly position: readonly [number, number, number]; readonly yawRadians: number; readonly uniformScale?: number }>;
type RestoreCommand = CanonicalCommand<"ifc.restore", { readonly snapshot: string }>;
type IfcCommand = PoseCommand | RestoreCommand;
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
        ? adapter.write(state.bytes.slice(), command.payload.ifcGlobalId, { position: command.payload.position, yawRadians: command.payload.yawRadians, ...(command.payload.uniformScale === undefined ? {} : { uniformScale: command.payload.uniformScale }) })
        : snapshots.get(command.payload.snapshot);
      if (!next) throw new Error("IFC history snapshot is unavailable.");
      return { state: { bytes: next.slice() }, inverse: { id: `inverse:${command.id}`, kind: "ifc.restore", authority: "canonical-ifc", payload: { snapshot: key } } };
    };
    this.#processor = new CommandProcessor({ bytes: bytes.slice() }, resolve);
  }
  get bytes(): Uint8Array { return this.#processor.state.bytes.slice(); }
  get history(): CommandHistoryStatus { return this.#processor.history; }
  read(ifcGlobalId: string): FurnitureWorldPose { return this.#adapter.read(this.bytes, ifcGlobalId); }
  place(ifcGlobalId: string, pose: FurnitureWorldPose): void {
    this.#sequence++;
    this.#processor.execute({ id: `ifc-pose:${this.#sequence}`, commands: [{ id: `ifc-pose-command:${this.#sequence}`, kind: "ifc.furniture.pose", authority: "canonical-ifc", payload: { ifcGlobalId, position: pose.position, yawRadians: pose.yawRadians, ...(pose.uniformScale === undefined ? {} : { uniformScale: pose.uniformScale }) } }] });
  }
  undo(): boolean { return this.#processor.undo() !== null; }
  redo(): boolean { return this.#processor.redo() !== null; }
}
