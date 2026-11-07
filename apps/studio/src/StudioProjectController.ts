import {
  TwinEditor,
  IfcFurnitureEditor,
  type IfcFurnitureAdapter,
  type FurnitureWorldPose,
  canonicalTwinFingerprint,
  type CommandHistoryStatus,
  type DevicePlacement,
} from "@teldra/application";
import type { TwinProject } from "@teldra/domain";
import type { ProjectPersistenceSession, ScenePlacementOverride, SceneProvenance } from "@teldra/project-format";

export interface StudioBuildingData { bytes: Uint8Array; placements: readonly ScenePlacementOverride[]; scene: SceneProvenance }
export interface StudioBuildingContext extends StudioBuildingData { sourceBytes: Uint8Array; createAdapter(): Promise<IfcFurnitureAdapter> }

export class StudioProjectController {
  readonly #editor: TwinEditor;
  readonly #persistence: ProjectPersistenceSession<TwinProject>;
  #selectedCanonicalId: string | null = null;
  #building?: StudioBuildingContext;
  #ifc?: IfcFurnitureEditor;
  #ifcAdapter?: IfcFurnitureAdapter;
  #originalBytes?: Uint8Array;
  #sourcePoses = new Map<string, FurnitureWorldPose>();
  #undo: ("twin" | "ifc")[] = [];
  #redo: ("twin" | "ifc")[] = [];
  #revision: number;

  constructor(
    initialTwin: TwinProject,
    persistence: ProjectPersistenceSession<TwinProject>,
    building?: StudioBuildingContext,
  ) {
    this.#persistence = persistence;
    this.#revision = persistence.savedRevision ?? 0;
    if (building) { this.#building = building; this.#originalBytes = building.bytes.slice(); }
    this.#editor = new TwinEditor(
      initialTwin,
      persistence.savedRevision ?? 0,
    );
    this.#syncPersistence();
  }

  get twin(): Readonly<TwinProject> {
    return this.#editor.twin;
  }

  get revision(): number {
    return this.#revision;
  }

  get history(): CommandHistoryStatus {
    return { revision: this.#revision, canUndo: this.#undo.length > 0, canRedo: this.#redo.length > 0, undoDepth: this.#undo.length, redoDepth: this.#redo.length };
  }

  get dirty(): boolean {
    return this.#persistence.dirty;
  }

  get persistenceStatus() {
    return this.#persistence.status;
  }

  get selectedCanonicalId(): string | null {
    return this.#selectedCanonicalId;
  }

  get selectedDevice() {
    const selectedId = this.#selectedCanonicalId;
    if (selectedId === null) return undefined;
    return this.#editor.twin.devices.find((device) => device.id === selectedId);
  }

  get selectedBuildingRef() {
    const selectedId = this.#selectedCanonicalId;
    if (selectedId === null) return undefined;
    return this.#editor.twin.building.refs.find((ref) => ref.id === selectedId);
  }

  selectCanonicalId(canonicalId: string | null): void {
    this.#selectedCanonicalId = canonicalId;
  }

  renameDevice(
    deviceId: string,
    name: string,
    correlationId?: string,
  ): void {
    this.#editor.renameDevice(deviceId, name, correlationId);
    this.#record("twin");
  }

  placeDevice(deviceId: string, placement: DevicePlacement, correlationId?: string): void {
    this.#editor.placeDevice(deviceId, placement, correlationId);
    this.#record("twin");
  }

  async prepareFurnitureEditing(canonicalId: string): Promise<FurnitureWorldPose> {
    const context = this.#building;
    if (!context) throw new Error("This project has no editable IFC scene.");
    const ref = this.#furnitureRef(canonicalId);
    if (!context.scene.nodes.some((node) => node.canonicalId === canonicalId && node.ifcGlobalId === ref.ifcGlobalId)) throw new Error("This furniture has no mapped scene geometry.");
    if (!this.#ifc) {
      const adapter = await context.createAdapter();
      if (!this.#ifc) { this.#ifcAdapter = adapter; this.#ifc = new IfcFurnitureEditor(context.bytes, adapter); }
    }
    const current = this.#ifc.read(ref.ifcGlobalId);
    if (!this.#sourcePoses.has(canonicalId)) {
      this.#sourcePoses.set(canonicalId, this.#ifcAdapter!.read(context.sourceBytes, ref.ifcGlobalId));
    }
    return current;
  }
  furniturePose(canonicalId: string): FurnitureWorldPose {
    if (!this.#ifc) throw new Error("Prepare IFC editing first.");
    return this.#ifc.read(this.#furnitureRef(canonicalId).ifcGlobalId);
  }
  furniturePlacement(canonicalId: string): { canonicalId: string; original: FurnitureWorldPose; current: FurnitureWorldPose } {
    const original = this.#sourcePoses.get(canonicalId);
    if (!original) throw new Error("Prepare IFC editing first.");
    return { canonicalId, original, current: this.furniturePose(canonicalId) };
  }
  placeFurniture(canonicalId: string, pose: FurnitureWorldPose): void {
    if (!this.#ifc || !this.#sourcePoses.has(canonicalId)) throw new Error("Prepare IFC editing first.");
    this.#ifc.place(this.#furnitureRef(canonicalId).ifcGlobalId, pose);
    this.#record("ifc");
  }
  get placementOverrides(): readonly ScenePlacementOverride[] {
    const context = this.#building;
    if (!context) return [];
    const result = new Map(context.placements.map((entry) => [entry.canonicalId, entry]));
    if (this.#ifc) for (const [id, source] of this.#sourcePoses) {
      const ref = this.#furnitureRef(id); const current = this.#ifc.read(ref.ifcGlobalId);
      result.set(id, { canonicalId: id, ifcGlobalId: ref.ifcGlobalId, matrix: poseDelta(source, current) });
    }
    return [...result.values()];
  }
  #furnitureRef(id: string) {
    const ref = this.twin.building.refs.find((candidate) => candidate.id === id && ["furniture", "fixture", "distribution-element", "other"].includes(candidate.kind));
    if (!ref) throw new Error("Only supported canonical IFC elements can be edited.");
    return ref;
  }
  #record(kind: "twin" | "ifc"): void { this.#undo.push(kind); this.#redo = []; this.#revision++; this.#syncPersistence(); }
  undo(): boolean {
    const kind = this.#undo.at(-1); if (!kind) return false;
    const result = kind === "twin" ? this.#editor.undo() !== null : this.#ifc?.undo() === true;
    if (!result) throw new Error("Inconsistent project history.");
    this.#undo.pop(); this.#redo.push(kind); this.#revision++; this.#syncPersistence(); return true;
  }
  redo(): boolean {
    const kind = this.#redo.at(-1); if (!kind) return false;
    const result = kind === "twin" ? this.#editor.redo() !== null : this.#ifc?.redo() === true;
    if (!result) throw new Error("Inconsistent project history.");
    this.#redo.pop(); this.#undo.push(kind); this.#revision++; this.#syncPersistence(); return true;
  }

  async save(): Promise<void> {
    const canonical = structuredClone(this.#editor.twin) as TwinProject;

    await this.#persistence.save({
      revision: this.#revision,
      fingerprint: this.#fingerprint(canonical),
      canonical,
      ...(this.#building && this.#ifc ? { derived: { bytes: this.#ifc.bytes, placements: this.placementOverrides, scene: this.#building.scene } satisfies StudioBuildingData } : {}),
    });
  }

  async autosave(): Promise<void> {
    const canonical = structuredClone(this.#editor.twin) as TwinProject;

    await this.#persistence.autosave({
      revision: this.#revision,
      fingerprint: this.#fingerprint(canonical),
      canonical,
      ...(this.#building && this.#ifc ? { derived: { bytes: this.#ifc.bytes, placements: this.placementOverrides, scene: this.#building.scene } satisfies StudioBuildingData } : {}),
    });
  }

  #fingerprint(twin: TwinProject): string {
    const base = canonicalTwinFingerprint(twin);
    const bytes = this.#ifc?.bytes;
    if (!bytes || !this.#originalBytes || (bytes.length === this.#originalBytes.length && bytes.every((v, i) => v === this.#originalBytes![i]))) return base;
    let encoded = ""; for (let i = 0; i < bytes.length; i += 8192) encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return base + ":ifc:" + btoa(encoded);
  }
  #syncPersistence(): void {
    this.#persistence.markCurrent(
      this.#revision,
      this.#fingerprint(this.#editor.twin as TwinProject),
    );
  }
}

function poseDelta(source: FurnitureWorldPose, current: FurnitureWorldPose): number[] {
  const angle = current.yawRadians - source.yawRadians, scale = (current.uniformScale ?? 1) / (source.uniformScale ?? 1), c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
  return [c,s,0,0,-s,c,0,0,0,0,scale,0,current.position[0]-c*source.position[0]+s*source.position[1],current.position[1]-s*source.position[0]-c*source.position[1],current.position[2]-scale*source.position[2],1];
}
/** Check persisted presentation deltas against both authoritative IFC placements. */
export function validateIfcScenePlacements(adapter: IfcFurnitureAdapter, sourceBytes: Uint8Array, currentBytes: Uint8Array, placements: readonly ScenePlacementOverride[]): void {
  for (const placement of placements) {
    const source = adapter.read(sourceBytes, placement.ifcGlobalId);
    const current = adapter.read(currentBytes, placement.ifcGlobalId);
    const expected = poseDelta(source, current);
    if (placement.matrix.length !== expected.length || expected.some((value, i) => Math.abs(value - placement.matrix[i]!) > 1e-6)) throw new Error(`Scene placement for "${placement.canonicalId}" does not match its IFC placements.`);
  }
}
