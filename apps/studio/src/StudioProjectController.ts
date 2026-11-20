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
  assertFurnitureRemovable,
  nextFurnitureCopyId,
  ifcGlobalIdFromBytes,
  type CommandHistoryStatus,
  type DevicePlacement,
} from "@teldra/application";
import type { TwinProject } from "@teldra/domain";
import type { ProjectPersistenceSession, ScenePlacementOverride, SceneProvenance } from "@teldra/project-format";
import type { SceneMeshSink } from "@teldra/projection";
import type { TeldraSceneManifest } from "@teldra/scene-manifest";
import { StudioSceneSync, type SceneModelCache, type SceneSyncApplied, type SceneSyncStatus } from "./sceneSync";

export interface StudioBuildingData { bytes: Uint8Array; placements: readonly ScenePlacementOverride[]; scene: SceneProvenance }
export interface StudioBuildingContext extends StudioBuildingData {
  sourceBytes: Uint8Array;
  createAdapter(): Promise<IfcFurnitureAdapter>;
  /** Opens the IFC read model used to regenerate derived meshes. Absent: the 3D scene is never patched in place. */
  createModelCache?(): Promise<SceneModelCache>;
}
/** What the controller needs from a loaded 3D viewport: the mesh sink plus the manifest the scene was built from. */
export interface SceneRenderer { readonly sink: SceneMeshSink; readonly manifest: TeldraSceneManifest }
const FURNITURE_KINDS = ["furniture", "fixture", "other", "distribution-element"];
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);

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
  /** Installed only by a loaded renderer that has inspected physical GLB mesh parts. */
  #affineProjectionValidator: ((canonicalId: string, canonicalDelta: readonly number[]) => void) | undefined;
  /** "both" = one atomic user step that changed IFC and the twin together (duplicate / remove). */
  #undo: ("twin" | "ifc" | "both")[] = [];
  #redo: ("twin" | "ifc" | "both")[] = [];
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
    await this.#ensureIfc();
    const current = this.#ifc!.read(ref.ifcGlobalId);
    const regenerated = this.#renderBaseline.get(canonicalId);
    if (regenerated && this.isSceneBacked(canonicalId)) {
      this.#prepareRegenerated(canonicalId, ref.ifcGlobalId, this.#resolveBaseline(canonicalId, ref.ifcGlobalId, current)); return current;
    }
    if (!this.isSceneBacked(canonicalId)) {
      // Added after the 3D scene was built (a duplicate): numeric editing against IFC only; no scene delta exists to project.
      if (!this.#sourcePoses.has(canonicalId)) this.#sourcePoses.set(canonicalId, current);
      this.#scaleUnsupported.set(canonicalId, "Scale needs the 3D scene geometry, which this element does not have yet.");
      this.#dimensionsUnsupported.set(canonicalId, "Source dimensions are unavailable until the 3D scene has this element.");
      return current;
    }
    if (!this.#sourcePoses.has(canonicalId)) {
      this.#sourcePoses.set(canonicalId, this.#ifcAdapter!.read(context.sourceBytes, ref.ifcGlobalId));
    }
    if (!this.#sourceScales.has(canonicalId) && !this.#scaleUnsupported.has(canonicalId)) {
      try {
        const sourceScale = this.#ifcAdapter!.readScale?.(context.sourceBytes, ref.ifcGlobalId);
        if (!sourceScale) throw new Error("This IFC adapter does not support mapped geometry scaling.");
        this.#ifc!.readScale(ref.ifcGlobalId); // Validate both versions.
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
  async #ensureIfc(): Promise<void> {
    const context = this.#building;
    if (!context) throw new Error("This project has no editable IFC scene.");
    if (this.#ifc) return;
    const adapter = await context.createAdapter();
    if (!this.#ifc) { this.#ifcAdapter = adapter; this.#ifc = new IfcFurnitureEditor(context.bytes, adapter); }
  }
  /** True when the 3D scene currently has geometry for this canonical furniture. */
  isSceneBacked(canonicalId: string): boolean {
    const ref = this.twin.building.refs.find(value => value.id === canonicalId);
    if (!ref) return false;
    if (!this.#sync) return this.#inGlb(canonicalId);
    // A mesh whose canonical change failed to regenerate is obsolete: never treat it as editable/pickable geometry.
    return this.#sync.renders(canonicalId, ref.ifcGlobalId) && !this.#sync.staleGlobalIds.includes(ref.ifcGlobalId);
  }
  /** Canonical IFC revision the model is at, and the revision the viewport actually shows (null: no live scene sync). */
  get renderedRevision(): number | null { return this.#sync ? this.#sync.reflectedRevision : this.#renderer ? this.#attachedRevision : null; }
  /** Canonical ids whose shown geometry is obsolete because regeneration failed or is still pending. */
  get staleCanonicalIds(): readonly string[] {
    const stale = new Set(this.#sync?.staleGlobalIds ?? []);
    return [...stale].flatMap(guid => { const id = this.#knownGlobalIds.get(guid) ?? this.twin.building.refs.find(ref => ref.ifcGlobalId === guid)?.id; return id ? [id] : []; });
  }
  isSceneStale(canonicalId: string): boolean { return this.staleCanonicalIds.includes(canonicalId); }
  /** Stage timings of the last successful regeneration (tessellate / apply / total), for diagnostics and performance budgets. */
  get sceneTimings() { return this.#sync?.timings; }
  /** The baked GLB the project opened with has a mesh for this canonical id (original, unregenerated geometry). */
  #inGlb(canonicalId: string): boolean {
    const ref = this.twin.building.refs.find(value => value.id === canonicalId);
    return !!ref && !!this.#building?.scene.nodes.some(node => node.canonicalId === canonicalId && node.ifcGlobalId === ref.ifcGlobalId);
  }
  #lifecycleIds = new Set<string>();

  // --- derived 3D scene synchronisation ---------------------------------------------------------------------------------
  #renderer: SceneRenderer | undefined;
  #sync: StudioSceneSync | undefined;
  #syncPromise: Promise<StudioSceneSync | undefined> | undefined;
  #syncError: string | undefined;
  #attachedRevision = 0;
  #pendingSync = new Set<Promise<unknown>>();
  #sceneListeners = new Set<() => void>();
  /** Where each regenerated mesh is baked: its IFC pose/scale at generation. Gizmo and live placement deltas are relative to this. */
  /**
   * An entry with no `pose` is *pending*: its mesh was just generated from current IFC and the element has not been edited
   * since, so the baseline equals the current IFC state and costs nothing. It is resolved (one IFC read) only when editing
   * starts, before the first change. This keeps regeneration free of per-element IFC re-reads.
   */
  #renderBaseline = new Map<string, { pose?: FurnitureWorldPose; scale?: FurnitureGeometryScale }>();
  /** Source GlobalId of each duplicate, so its mesh reuses the source's material. */
  #copySources = new Map<string, string>();
  #knownGlobalIds = new Map<string, string>();

  get sceneSyncStatus(): SceneSyncStatus {
    if (this.#syncError) return { state: "degraded", reason: "failed", message: this.#syncError };
    return this.#sync?.status ?? { state: "in-sync" };
  }
  /** Fires after the rendered scene or its status changed. Returns the unsubscribe function. */
  onSceneChange(listener: () => void): () => void { this.#sceneListeners.add(listener); return () => { this.#sceneListeners.delete(listener); }; }
  #notifyScene(): void { for (const listener of [...this.#sceneListeners]) listener(); }

  /**
   * Binds the loaded viewport. Elements whose IFC state is not what the baked GLB shows (saved copies, elements deleted in
   * an earlier session) are regenerated/removed from canonical IFC, not guessed from the GLB. Resolves when settled.
   */
  async attachSceneRenderer(renderer: SceneRenderer): Promise<void> {
    const context = this.#building;
    if (!context?.createModelCache) return;
    this.detachSceneRenderer();
    this.#renderer = renderer;
    this.#attachedRevision = this.#revision;
    for (const ref of this.twin.building.refs) this.#knownGlobalIds.set(ref.ifcGlobalId, ref.id);
    const rendered = new Set(renderer.manifest.nodes.flatMap(node => node.ifcGlobalId === undefined ? [] : [node.ifcGlobalId]));
    const unrendered = this.twin.building.refs.filter(ref => FURNITURE_KINDS.includes(ref.kind) && !rendered.has(ref.ifcGlobalId));
    const bytes = this.#ifc ? this.#ifc.bytes : context.bytes;
    if (sameBytes(context.sourceBytes, bytes) && unrendered.length === 0) return; // GLB is exactly what IFC describes
    const revision = this.#revision;
    const run = (async () => {
      const sync = await this.#ensureSync(true);
      await sync?.reconcile(revision, bytes, unrendered.map(ref => ref.ifcGlobalId), context.sourceBytes);
    })().catch(error => this.#failSync(error));
    this.#pendingSync.add(run); void run.finally(() => this.#pendingSync.delete(run));
    await run; await this.#sync?.idle();
  }
  detachSceneRenderer(): void {
    this.#sync?.dispose();
    this.#sync = undefined; this.#syncPromise = undefined; this.#syncError = undefined; this.#renderer = undefined;
    this.#renderBaseline.clear();
  }
  /** Resolves when every scene regeneration requested so far has settled (applied, superseded or degraded). */
  async sceneIdle(): Promise<void> {
    while (this.#pendingSync.size) await Promise.allSettled([...this.#pendingSync]);
    await this.#sync?.idle();
  }
  /** Re-attempt regeneration of everything still pending after a failure. */
  async retrySceneSync(): Promise<void> {
    if (!this.#renderer) return;
    this.#syncError = undefined; this.#syncPromise = this.#sync ? this.#syncPromise : undefined;
    const run = (async () => { const sync = await this.#ensureSync(); await sync?.retry(); })().catch(error => this.#failSync(error));
    this.#pendingSync.add(run); void run.finally(() => this.#pendingSync.delete(run));
    await run; await this.#sync?.idle(); this.#notifyScene();
  }
  #autoRebuilt = false;
  /** Full regeneration of every rendered element from current IFC (the recovery path when incremental updates fail). */
  async rebuildScene(): Promise<void> {
    if (!this.#renderer) return;
    const run = (async () => { const sync = await this.#ensureSync(); await sync?.fullRebuild(); })().catch(error => this.#failSync(error));
    this.#pendingSync.add(run); void run.finally(() => this.#pendingSync.delete(run));
    await run; await this.#sync?.idle(); this.#notifyScene();
  }
  #failSync(error: unknown): void {
    this.#syncError = `The 3D view could not be prepared for live updates: ${error instanceof Error ? error.message : String(error)}`;
    this.#notifyScene();
  }
  #ensureSync(reconciling = false): Promise<StudioSceneSync | undefined> {
    return this.#syncPromise ??= (async () => {
      const context = this.#building, renderer = this.#renderer;
      if (!context?.createModelCache || !renderer) return undefined;
      await this.#ensureIfc();
      const cache = await context.createModelCache();
      if (this.#renderer !== renderer) { cache.dispose(); return undefined; }
      const sync = new StudioSceneSync({
        manifest: renderer.manifest, sink: renderer.sink, cache, initialRevision: reconciling ? this.#attachedRevision - 1 : this.#attachedRevision,
        resolveCanonicalId: guid => this.#knownGlobalIds.get(guid) ?? this.twin.building.refs.find(ref => ref.ifcGlobalId === guid)?.id,
        resolveMaterialSource: guid => this.#copySources.get(guid),
        onApplied: applied => { this.#baselineRegenerated(applied); this.#notifyScene(); },
        onStatus: status => {
          if (status.state === "in-sync") this.#autoRebuilt = false;
          // Incremental update failed after a successful canonical transaction: automatically try one full regeneration.
          else if (status.state === "degraded" && !this.#autoRebuilt) { this.#autoRebuilt = true; queueMicrotask(() => { void this.rebuildScene(); }); }
          this.#notifyScene();
        },
      });
      this.#sync = sync;
      return sync;
    })().catch(error => { this.#syncPromise = undefined; throw error; });
  }
  /** After a duplicate/remove/undo/redo: regenerate exactly the elements the IFC editor reports as touched. */
  #syncScene(affected: readonly string[]): void {
    if (!this.#renderer || !this.#building?.createModelCache || !this.#ifc || affected.length === 0) return;
    const revision = this.#revision, bytes = this.#ifc.bytes; // one consistent snapshot, taken synchronously
    const run = (async () => { const sync = await this.#ensureSync(); await sync?.request(revision, bytes, affected); })()
      .catch(error => this.#failSync(error));
    this.#pendingSync.add(run); void run.finally(() => this.#pendingSync.delete(run));
  }
  /** Meshes were just generated from current IFC: their baseline is pending (see `#renderBaseline`); caches tied to old meshes are dropped. */
  #baselineRegenerated(applied: SceneSyncApplied): void {
    this.#sceneVersion++;
    const idOf = (guid: string) => this.#knownGlobalIds.get(guid) ?? this.twin.building.refs.find(ref => ref.ifcGlobalId === guid)?.id;
    for (const guid of applied.removed) { const id = idOf(guid); if (id) this.#renderBaseline.delete(id); }
    for (const guid of applied.generated) {
      const id = idOf(guid); if (!id) continue;
      this.#renderBaseline.set(id, {});
      for (const map of [this.#scaleUnsupported, this.#dimensionsUnsupported]) map.delete(id);
      this.#sourceNominalDimensions.delete(id);
    }
  }
  /** Resolve a pending baseline from the current IFC (valid because nothing touched the element since generation). */
  #resolveBaseline(id: string, globalId: string, current: FurnitureWorldPose): { pose: FurnitureWorldPose; scale?: FurnitureGeometryScale } {
    const existing = this.#renderBaseline.get(id)!;
    if (existing.pose) return { pose: existing.pose, ...(existing.scale ? { scale: existing.scale } : {}) };
    let scale: FurnitureGeometryScale | undefined;
    try { scale = this.#ifc!.readScale(globalId); } catch { /* no per-instance scale */ }
    const resolved = { pose: current, ...(scale ? { scale } : {}) };
    this.#renderBaseline.set(id, resolved);
    return resolved;
  }
  /** Where the displayed mesh is baked. A regenerated mesh that is still pending has no editing baseline until editing is prepared. */
  #poseBaseline(id: string): FurnitureWorldPose | undefined {
    const regenerated = this.#renderBaseline.get(id);
    return regenerated ? regenerated.pose : this.#sourcePoses.get(id);
  }
  #scaleBaseline(id: string): FurnitureGeometryScale | undefined {
    const regenerated = this.#renderBaseline.get(id);
    return regenerated ? regenerated.scale : this.#sourceScales.get(id);
  }
  #prepareRegenerated(id: string, globalId: string, baseline: { pose: FurnitureWorldPose; scale?: FurnitureGeometryScale }): void {
    const context = this.#building!, adapter = this.#ifcAdapter!;
    if (!baseline.scale) this.#scaleUnsupported.set(id, "This element's IFC geometry has no per-instance mapped scale.");
    else if (!this.#scaleUnsupported.has(id)) {
      try { this.#ifc!.readScale(globalId); } catch (error) { this.#scaleUnsupported.set(id, error instanceof Error ? error.message : String(error)); }
    }
    if (baseline.scale && !this.#scaleUnsupported.has(id) && !this.#sourceNominalDimensions.has(id) && !this.#dimensionsUnsupported.has(id)) {
      try {
        const original = adapter.readScale?.(context.sourceBytes, globalId), dimensions = adapter.readSourceDimensions?.(context.sourceBytes, globalId);
        if (!original || !dimensions) throw new Error("This IFC object has no Sweet Home 3D nominal source dimensions.");
        this.#sourceNominalDimensions.set(id, nominalDimensionsForScale(dimensions, original, baseline.scale) as FurnitureSourceDimensions);
      } catch (error) { this.#dimensionsUnsupported.set(id, error instanceof Error ? error.message : String(error)); }
    }
  }
  #dropStaleSelection(): void {
    const id = this.#selectedCanonicalId;
    // Drop the selection only when its element is gone (its mesh was removed); selecting survivors is untouched.
    if (id && this.#lifecycleIds.has(id) && !this.twin.building.refs.some(ref => ref.id === id)) this.#selectedCanonicalId = null;
  }
  /**
   * Duplicate canonical IFC furniture as one atomic, undoable step: a new IFC element under a fresh GlobalId plus a new twin
   * building reference under a fresh canonical id. Devices, capabilities and external bindings are never copied.
   */
  async duplicateFurniture(canonicalId: string, offset: readonly [number, number, number] = [0.5, 0, 0]): Promise<string> {
    const ref = this.#furnitureRef(canonicalId);
    await this.#ensureIfc();
    const taken = [...this.twin.building.refs.map(value => value.id), ...this.twin.devices.flatMap(device => [device.id, ...device.capabilities.map(c => c.id)]), ...this.twin.bindings.map(value => value.id)];
    const newId = nextFurnitureCopyId(canonicalId, taken);
    const used = new Set(this.twin.building.refs.map(value => value.ifcGlobalId));
    let newGuid: string;
    do newGuid = ifcGlobalIdFromBytes(crypto.getRandomValues(new Uint8Array(16))); while (used.has(newGuid));
    const name = `${ref.name ?? ref.kind} (copy)`;
    this.#ifc!.duplicate(ref.ifcGlobalId, newGuid, { offset, name });
    try { this.#editor.addBuildingRef({ id: newId, ifcGlobalId: newGuid, kind: ref.kind, name }); }
    catch (error) { this.#ifc!.undo(); throw error; }
    this.#lifecycleIds.add(newId);
    this.#knownGlobalIds.set(newGuid, newId); this.#copySources.set(newGuid, ref.ifcGlobalId);
    this.#record("both");
    this.#syncScene(this.#ifc!.lastAffectedGlobalIds);
    return newId;
  }
  /** Remove canonical IFC furniture atomically (IFC + twin). Vetoed while a twin device is attached; refused if IFC cannot be cleaned. */
  async removeFurniture(canonicalId: string): Promise<void> {
    const ref = this.#furnitureRef(canonicalId);
    assertFurnitureRemovable(this.twin, canonicalId); // veto first: nothing is touched when a device is attached
    await this.#ensureIfc();
    this.#ifc!.remove(ref.ifcGlobalId);
    try { this.#editor.removeBuildingRef(canonicalId); }
    catch (error) { this.#ifc!.undo(); throw error; }
    this.#lifecycleIds.add(canonicalId); this.#knownGlobalIds.set(ref.ifcGlobalId, canonicalId);
    if (this.#selectedCanonicalId === canonicalId) this.#selectedCanonicalId = null;
    this.#record("both");
    this.#syncScene(this.#ifc!.lastAffectedGlobalIds);
  }
  furniturePose(canonicalId: string): FurnitureWorldPose {
    if (!this.#ifc) throw new Error("Prepare IFC editing first.");
    return this.#ifc.read(this.#furnitureRef(canonicalId).ifcGlobalId);
  }
  furniturePlacement(canonicalId: string): { canonicalId: string; original: FurnitureWorldPose; current: FurnitureWorldPose; sourceScale?: FurnitureGeometryScale; currentScale?: FurnitureGeometryScale } {
    const original = this.#poseBaseline(canonicalId);
    if (!original) throw new Error("Prepare IFC editing first.");
    const sourceScale = this.#scaleBaseline(canonicalId);
    return {
      canonicalId, original, current: this.furniturePose(canonicalId),
      ...(sourceScale ? { sourceScale, currentScale: this.#ifc!.readScale(this.#furnitureRef(canonicalId).ifcGlobalId) } : {}),
    };
  }
  furnitureScaleStatus(canonicalId: string): { readonly supported: true; readonly scale: FurnitureGeometryScale } | { readonly supported: false; readonly reason: string } {
    if (!this.#ifc || !this.#poseBaseline(canonicalId))
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
    const baseline = this.#scaleBaseline(canonicalId);
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
    const baseline = this.#scaleBaseline(canonicalId);
    if (!source || !baseline) throw new Error("This IFC object has no source-authored nominal dimensions.");
    return scaleForNominalDimensions(source, baseline, requested);
  }
  /**
   * Projection of actual source triangle extents into currently authored local
   * IFC metre dimensions. Source bounds come from runtime geometry and are
   * never persisted as a second canonical dimension authority.
   */
  furnitureMeasuredSizeStatus(canonicalId: string, measuredSource: FurnitureSourceDimensions,
    previewScale?: FurnitureGeometryScale):
    | {readonly supported:true;readonly source:FurnitureSourceDimensions;readonly current:FurnitureSourceDimensions}
    | {readonly supported:false;readonly reason:string} {
    const baseline=this.#scaleBaseline(canonicalId);
    if(!baseline || !this.#ifc) return {supported:false,reason:"Mapped IFC geometry must be prepared before measuring its authored size."};
    try {
      const current=nominalDimensionsForScale(measuredSource,baseline,
        previewScale??this.#ifc.readScale(this.#furnitureRef(canonicalId).ifcGlobalId));
      return {supported:true,source:measuredSource,current};
    } catch(error) {return {supported:false,reason:error instanceof Error?error.message:String(error)};}
  }
  furnitureScaleForMeasuredSize(canonicalId:string,measuredSource:FurnitureSourceDimensions,
    requested:FurnitureSourceDimensions):FurnitureGeometryScale {
    const baseline=this.#scaleBaseline(canonicalId);
    if(!baseline) throw new Error("This IFC geometry has no validated source scale.");
    return scaleForNominalDimensions(measuredSource,baseline,requested);
  }
  setAffineProjectionValidator(validator: ((canonicalId: string, canonicalDelta: readonly number[]) => void) | null): void {
    this.#affineProjectionValidator = validator ?? undefined;
  }
  transformFurniture(canonicalId: string, pose: FurnitureWorldPose, scale: FurnitureGeometryScale): void {
    if (!this.#ifc || !this.#scaleBaseline(canonicalId)) throw new Error("This IFC furniture has no safely scalable mapped geometry.");
    this.#assertProjectableScale(canonicalId, pose, scale);
    this.#ifc.transform(this.#furnitureRef(canonicalId).ifcGlobalId, pose, scale);
    this.#record("ifc");
  }
  scaleFurniture(canonicalId: string, scale: FurnitureGeometryScale): void {
    if (!this.#ifc || !this.#scaleBaseline(canonicalId)) throw new Error("This IFC furniture has no safely scalable mapped geometry.");
    this.#assertProjectableScale(canonicalId, this.furniturePose(canonicalId), scale);
    this.#ifc.scale(this.#furnitureRef(canonicalId).ifcGlobalId, scale);
    this.#record("ifc");
  }
  placeFurniture(canonicalId: string, pose: FurnitureWorldPose): void {
    if (!this.#ifc || !this.#poseBaseline(canonicalId)) throw new Error("Prepare IFC editing first.");
    this.#ifc.place(this.#furnitureRef(canonicalId).ifcGlobalId, pose);
    this.#record("ifc");
  }
  #assertProjectableScale(id: string, pose: FurnitureWorldPose, scale: FurnitureGeometryScale): void {
    const source = this.#poseBaseline(id), baseline = this.#scaleBaseline(id);
    if (!source || !baseline) throw new Error("Original IFC scene scale is unavailable.");
    if (scale.length !== 3 || scale.some(v => !Number.isFinite(v) || v <= 0 || v > 1000))
      throw new Error("Invalid IFC geometry-scale factors.");
    const ratio = scale.map((value, i) => value / baseline[i]!) as [number, number, number];
    if (ratio.some(v => v <= 0 || v > 1000)) throw new Error("Scaled scene ratio is outside supported bounds.");
    const m = poseDelta(source, pose, ratio);
    // A lossless two-node Babylon affine factorization can represent the
    // shear, but only when the loaded physical GLB parts have passed the pure
    // runtime capability check. Headless clients remain conservative.
    const shear = m[0]!*m[4]! + m[1]!*m[5]!;
    const requiresAffine = Math.abs(shear) > 1e-6 * Math.max(1, ratio[0]!**2 + ratio[1]!**2);
    const nonuniform = Math.max(...ratio) - Math.min(...ratio) > 1e-7;
    // A source mesh may have additional local rotations not reflected in the
    // furniture's global matrix. Check all nonuniform edits when a renderer
    // is attached, not just those whose canonical XY block contains shear.
    if (this.#affineProjectionValidator && nonuniform) this.#affineProjectionValidator(id, m);
    else if (requiresAffine)
      throw new Error("Rotated nonuniform scaling requires a verified affine render projection.");
  }
  /** Bumped whenever the IFC bytes may have changed; keys the placement caches (each uncached read re-opens the IFC model). */
  #ifcVersion = 0;
  #sceneVersion = 0;
  #placementCache: { version: number; value: readonly ScenePlacementOverride[] } | undefined;
  #liveCache: { ifc: number; scene: number; value: readonly ScenePlacementOverride[] } | undefined;
  get placementOverrides(): readonly ScenePlacementOverride[] {
    if (this.#placementCache?.version === this.#ifcVersion) return this.#placementCache.value;
    const value = this.#computePlacementOverrides();
    this.#placementCache = { version: this.#ifcVersion, value };
    return value;
  }
  #computePlacementOverrides(): readonly ScenePlacementOverride[] {
    const context = this.#building;
    if (!context) return [];
    const live = new Set(this.twin.building.refs.map(ref => ref.id));
    const result = new Map(context.placements.filter(entry => live.has(entry.canonicalId)).map((entry) => [entry.canonicalId, entry]));
    if (this.#ifc) for (const [id, source] of this.#sourcePoses) {
      if (!this.twin.building.refs.some(value => value.id === id) || !this.#inGlb(id)) continue;
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
  /**
   * Placement deltas for the *live* viewport. Baked GLB elements are positioned relative to the GLB; regenerated meshes
   * (copies, restored elements) are baked at their IFC pose at generation, so their delta is relative to that baseline.
   * `placementOverrides` stays what is persisted: deltas against the original GLB only.
   */
  get liveSceneOverrides(): readonly ScenePlacementOverride[] {
    if (this.#liveCache && this.#liveCache.ifc === this.#ifcVersion && this.#liveCache.scene === this.#sceneVersion) return this.#liveCache.value;
    const value = this.#computeLiveOverrides();
    this.#liveCache = { ifc: this.#ifcVersion, scene: this.#sceneVersion, value };
    return value;
  }
  #computeLiveOverrides(): readonly ScenePlacementOverride[] {
    const persisted = this.placementOverrides;
    if (!this.#renderBaseline.size || !this.#ifc) return persisted;
    const live = new Map(persisted.map(entry => [entry.canonicalId, entry]));
    for (const [id, baseline] of this.#renderBaseline) {
      live.delete(id);
      const ref = this.twin.building.refs.find(value => value.id === id);
      if (!baseline.pose || !ref || !this.#sync?.renders(id, ref.ifcGlobalId)) continue; // pending: mesh already equals IFC
      const current = this.#ifc.read(ref.ifcGlobalId);
      let ratio: [number, number, number] | undefined;
      if (baseline.scale) {
        try {
          const now = this.#ifc.readScale(ref.ifcGlobalId);
          const next = now.map((value, i) => value / baseline.scale![i]!) as [number, number, number];
          if (next.some(value => Math.abs(value - 1) > 1e-8)) ratio = next;
        } catch { ratio = undefined; }
      }
      const matrix = poseDelta(baseline.pose, current, ratio);
      const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
      if (!ratio && matrix.every((value, i) => Math.abs(value - identity[i]!) < 1e-9)) continue;
      live.set(id, { canonicalId: id, ifcGlobalId: ref.ifcGlobalId, matrix, ...(ratio ? { scale: ratio } : {}) });
    }
    return [...live.values()];
  }
  #furnitureRef(id: string) {
    const ref = this.twin.building.refs.find((candidate) => candidate.id === id && ["furniture", "fixture", "other", "distribution-element"].includes(candidate.kind));
    if (!ref) throw new Error("Only canonical IFC furniture can be edited.");
    return ref;
  }
  #record(kind: "twin" | "ifc" | "both"): void { if (kind !== "twin") this.#ifcVersion++; this.#undo.push(kind); this.#redo = []; this.#revision++; this.#syncPersistence(); }
  undo(): boolean {
    const kind = this.#undo.at(-1); if (!kind) return false;
    const result = kind === "twin" ? this.#editor.undo() !== null
      : kind === "ifc" ? this.#ifc?.undo() === true
      : this.#editor.undo() !== null && this.#ifc?.undo() === true;
    if (!result) throw new Error("Inconsistent project history.");
    if (kind !== "twin") this.#ifcVersion++;
    this.#undo.pop(); this.#redo.push(kind); this.#revision++; this.#dropStaleSelection(); this.#syncPersistence();
    if (kind === "both") this.#syncScene(this.#ifc!.lastAffectedGlobalIds);
    return true;
  }
  redo(): boolean {
    const kind = this.#redo.at(-1); if (!kind) return false;
    const result = kind === "twin" ? this.#editor.redo() !== null
      : kind === "ifc" ? this.#ifc?.redo() === true
      : this.#ifc?.redo() === true && this.#editor.redo() !== null;
    if (!result) throw new Error("Inconsistent project history.");
    if (kind !== "twin") this.#ifcVersion++;
    this.#redo.pop(); this.#undo.push(kind); this.#revision++; this.#dropStaleSelection(); this.#syncPersistence();
    if (kind === "both") this.#syncScene(this.#ifc!.lastAffectedGlobalIds);
    return true;
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
    return base + ":ifc:" + hashBytes(bytes);
  }
  #syncPersistence(): void {
    this.#persistence.markCurrent(
      this.#revision,
      this.#fingerprint(this.#editor.twin as TwinProject),
    );
  }
}

/**
 * Two independent 32-bit multiplicative hashes over the IFC bytes plus length (about 40 ms for a 60 MB file). The previous
 * fingerprint base64-encoded the whole IFC on every history step, which cost seconds on large projects; this value only
 * decides "differs from the saved state", never identity.
 */
function hashBytes(bytes: Uint8Array): string {
  const words = Math.floor(bytes.length / 4);
  const view = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + words * 4));
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < view.length; i++) { const w = view[i]!; a = Math.imul(a ^ w, 0x01000193); b = Math.imul(b + w, 0x85ebca6b) ^ (b >>> 13); }
  for (let i = words * 4; i < bytes.length; i++) { a = Math.imul(a ^ bytes[i]!, 0x01000193); b = Math.imul(b + bytes[i]!, 0x85ebca6b) ^ (b >>> 13); }
  return `${bytes.length.toString(16)}-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
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
