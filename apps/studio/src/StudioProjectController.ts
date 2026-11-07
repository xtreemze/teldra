import {
  TwinEditor,
  IfcFurnitureEditor,
  type IfcFurnitureAdapter,
  type FurnitureWorldPose,
  type FurnitureGeometryScale,
  type FurnitureSourceDimensions,
  nominalDimensionsForScale,
  scaleForNominalDimensions,
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
  #sourceScales = new Map<string, FurnitureGeometryScale>();
  #scaleUnsupported = new Map<string, string>();
  #sourceNominalDimensions = new Map<string, FurnitureSourceDimensions>();
  #dimensionsUnsupported = new Map<string, string>();
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
    if (!this.#sourceScales.has(canonicalId) && !this.#scaleUnsupported.has(canonicalId)) {
      try {
        const sourceScale = this.#ifcAdapter!.readScale?.(context.sourceBytes, ref.ifcGlobalId);
        if (!sourceScale) throw new Error("This IFC adapter does not support mapped geometry scaling.");
        this.#ifc.readScale(ref.ifcGlobalId); // Validate both versions.
        this.#sourceScales.set(canonicalId, sourceScale);
      } catch (error) {
        this.#scaleUnsupported.set(canonicalId, error instanceof Error ? error.message : String(error));
      }
    }
    if (this.#sourceScales.has(canonicalId) &&
        !this.#sourceNominalDimensions.has(canonicalId) &&
        !this.#dimensionsUnsupported.has(canonicalId)) {
      try {
        const dimensions = this.#ifcAdapter!.readSourceDimensions?.(context.sourceBytes, ref.ifcGlobalId);
        if (!dimensions) throw new Error("This IFC object has no Sweet Home 3D nominal source dimensions.");
        const sourceScale = this.#sourceScales.get(canonicalId)!;
        nominalDimensionsForScale(dimensions, sourceScale, sourceScale);
        this.#sourceNominalDimensions.set(canonicalId, dimensions);
      } catch (error) {
        this.#dimensionsUnsupported.set(canonicalId, error instanceof Error ? error.message : String(error));
      }
    }
    return current;
  }
  furniturePose(canonicalId: string): FurnitureWorldPose {
    if (!this.#ifc) throw new Error("Prepare IFC editing first.");
    return this.#ifc.read(this.#furnitureRef(canonicalId).ifcGlobalId);
  }
  furniturePlacement(canonicalId: string): { canonicalId: string; original: FurnitureWorldPose; current: FurnitureWorldPose; sourceScale?: FurnitureGeometryScale; currentScale?: FurnitureGeometryScale } {
    const original = this.#sourcePoses.get(canonicalId);
    if (!original) throw new Error("Prepare IFC editing first.");
    const sourceScale = this.#sourceScales.get(canonicalId);
    return {
      canonicalId, original, current: this.furniturePose(canonicalId),
      ...(sourceScale ? { sourceScale, currentScale: this.#ifc!.readScale(this.#furnitureRef(canonicalId).ifcGlobalId) } : {}),
    };
  }
  furnitureScaleStatus(canonicalId: string): { readonly supported: true; readonly scale: FurnitureGeometryScale } | { readonly supported: false; readonly reason: string } {
    if (!this.#ifc || !this.#sourcePoses.has(canonicalId))
      return { supported: false, reason: "Open furniture editing before changing its geometry." };
    const reason = this.#scaleUnsupported.get(canonicalId);
    if (reason) return { supported: false, reason };
    try { return { supported: true, scale: this.#ifc.readScale(this.#furnitureRef(canonicalId).ifcGlobalId) }; }
    catch (error) { return { supported: false, reason: error instanceof Error ? error.message : String(error) }; }
  }
  furnitureDimensionStatus(canonicalId: string, previewScale?: FurnitureGeometryScale):
    | { readonly supported: true; readonly source: FurnitureSourceDimensions; readonly current: FurnitureSourceDimensions }
    | { readonly supported: false; readonly reason: string } {
    const source = this.#sourceNominalDimensions.get(canonicalId);
    const baseline = this.#sourceScales.get(canonicalId);
    if (!source || !baseline || !this.#ifc) return {
      supported: false,
      reason: this.#dimensionsUnsupported.get(canonicalId) ??
        "Source nominal dimensions are unavailable for this IFC object.",
    };
    try {
      const current = nominalDimensionsForScale(source, baseline,
        previewScale ?? this.#ifc.readScale(this.#furnitureRef(canonicalId).ifcGlobalId));
      return { supported: true, source, current };
    } catch (error) {
      return { supported: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  /** Preview conversion only. Commit remains through transformFurniture/scaleFurniture. */
  furnitureScaleForDimensions(canonicalId: string, requested: FurnitureSourceDimensions): FurnitureGeometryScale {
    const source = this.#sourceNominalDimensions.get(canonicalId);
    const baseline = this.#sourceScales.get(canonicalId);
    if (!source || !baseline) throw new Error("This IFC object has no source-authored nominal dimensions.");
    return scaleForNominalDimensions(source, baseline, requested);
  }
  transformFurniture(canonicalId: string, pose: FurnitureWorldPose, scale: FurnitureGeometryScale): void {
    if (!this.#ifc || !this.#sourceScales.has(canonicalId)) throw new Error("This IFC furniture has no safely scalable mapped geometry.");
    this.#assertProjectableScale(canonicalId, pose, scale);
    this.#ifc.transform(this.#furnitureRef(canonicalId).ifcGlobalId, pose, scale);
    this.#record("ifc");
  }
  scaleFurniture(canonicalId: string, scale: FurnitureGeometryScale): void {
    if (!this.#ifc || !this.#sourceScales.has(canonicalId)) throw new Error("This IFC furniture has no safely scalable mapped geometry.");
    this.#assertProjectableScale(canonicalId, this.furniturePose(canonicalId), scale);
    this.#ifc.scale(this.#furnitureRef(canonicalId).ifcGlobalId, scale);
    this.#record("ifc");
  }
  placeFurniture(canonicalId: string, pose: FurnitureWorldPose): void {
    if (!this.#ifc || !this.#sourcePoses.has(canonicalId)) throw new Error("Prepare IFC editing first.");
    this.#ifc.place(this.#furnitureRef(canonicalId).ifcGlobalId, pose);
    this.#record("ifc");
  }
  #assertProjectableScale(id: string, pose: FurnitureWorldPose, scale: FurnitureGeometryScale): void {
    const source = this.#sourcePoses.get(id), baseline = this.#sourceScales.get(id);
    if (!source || !baseline) throw new Error("Original IFC scene scale is unavailable.");
    if (scale.length !== 3 || scale.some(v => !Number.isFinite(v) || v <= 0 || v > 1000))
      throw new Error("Invalid IFC geometry-scale factors.");
    const ratio = scale.map((value, i) => value / baseline[i]!) as [number, number, number];
    if (ratio.some(v => v <= 0 || v > 1000)) throw new Error("Scaled scene ratio is outside supported bounds.");
    const m = poseDelta(source, pose, ratio);
    // Babylon Mesh transforms cannot express an arbitrary shear matrix.
    // Until geometry regeneration is available, reject rather than persist
    // an IFC-valid change that the unchanged GLB cannot faithfully render.
    const shear = m[0]!*m[4]! + m[1]!*m[5]!;
    if (Math.abs(shear) > 1e-6 * Math.max(1, ratio[0]!**2 + ratio[1]!**2))
      throw new Error("Nonuniform scaling of rotated source geometry requires GLB regeneration; this scene cannot project shear safely.");
  }
  get placementOverrides(): readonly ScenePlacementOverride[] {
    const context = this.#building;
    if (!context) return [];
    const result = new Map(context.placements.map((entry) => [entry.canonicalId, entry]));
    if (this.#ifc) for (const [id, source] of this.#sourcePoses) {
      const ref = this.#furnitureRef(id); const current = this.#ifc.read(ref.ifcGlobalId);
      const originalScale = this.#sourceScales.get(id);
      const currentScale = originalScale && this.#ifc.readScale(ref.ifcGlobalId);
      const ratio = originalScale && currentScale && currentScale.map((value, i) => value / originalScale[i]!) as [number, number, number];
      const alteredScale = ratio && ratio.some(value => Math.abs(value - 1) > 1e-8);
      result.set(id, {
        canonicalId: id, ifcGlobalId: ref.ifcGlobalId,
        matrix: poseDelta(source, current, alteredScale ? ratio : undefined),
        ...(alteredScale ? { scale: ratio } : {}),
      });
    }
    return [...result.values()];
  }
  #furnitureRef(id: string) {
    const ref = this.twin.building.refs.find((candidate) => candidate.id === id && ["furniture", "fixture", "other", "distribution-element"].includes(candidate.kind));
    if (!ref) throw new Error("Only canonical IFC furniture can be edited.");
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

function poseDelta(source: FurnitureWorldPose, current: FurnitureWorldPose, scale: FurnitureGeometryScale = [1,1,1]): number[] {
  const cs = Math.cos(source.yawRadians), ss = Math.sin(source.yawRadians);
  const cc = Math.cos(current.yawRadians), sc = Math.sin(current.yawRadians);
  const [sx, sy, sz] = scale;
  // In column-vector notation this is T_current * S_relative * T_source^-1.
  // Matrix storage is column-major for the derived GLB scene.
  const a00 = cc*sx*cs + sc*sy*ss, a01 = cc*sx*ss - sc*sy*cs;
  const a10 = sc*sx*cs - cc*sy*ss, a11 = sc*sx*ss + cc*sy*cs;
  return [a00,a10,0,0,a01,a11,0,0,0,0,sz,0,
    current.position[0]-a00*source.position[0]-a01*source.position[1],
    current.position[1]-a10*source.position[0]-a11*source.position[1],
    current.position[2]-sz*source.position[2],1];
}
/** Check persisted presentation deltas against both authoritative IFC placements. */
export function validateIfcScenePlacements(adapter: IfcFurnitureAdapter, sourceBytes: Uint8Array, currentBytes: Uint8Array, placements: readonly ScenePlacementOverride[]): void {
  for (const placement of placements) {
    const source = adapter.read(sourceBytes, placement.ifcGlobalId);
    const current = adapter.read(currentBytes, placement.ifcGlobalId);
    const oldScale = adapter.readScale ? (() => { try { return adapter.readScale!(sourceBytes, placement.ifcGlobalId); } catch { return null; } })() : null;
    const newScale = oldScale && adapter.readScale!(currentBytes, placement.ifcGlobalId);
    const ratio = oldScale && newScale && newScale.map((value, i) => value / oldScale[i]!) as [number, number, number];
    const scaled = !!ratio && ratio.some(value => Math.abs(value - 1) > 1e-8);
    if (scaled !== (placement.scale !== undefined) ||
        (scaled && (placement.scale?.some((v, i) => Math.abs(v-ratio![i]!) > 1e-6) ?? true)))
      throw new Error("Scene geometry scale does not match authoritative IFC geometry.");
    const expected = poseDelta(source, current, ratio || undefined);
    if (placement.matrix.length !== expected.length || expected.some((value, i) => Math.abs(value - placement.matrix[i]!) > 1e-6)) throw new Error(`Scene placement for "${placement.canonicalId}" does not match its IFC placements.`);
  }
}
