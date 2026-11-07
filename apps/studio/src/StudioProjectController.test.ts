import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import goldenIfc from "../../../fixtures/projects/golden-home/building.ifc?raw";
import { IfcAPI } from "web-ifc";
import { readFurniturePose, writeFurniturePose, readFurnitureGeometryScale, writeFurnitureGeometryScale } from "@teldra/ifc-edit";
import { canonicalTwinFingerprint } from "@teldra/application";
import {
  assertTwinIntegrity,
  type TwinProject,
} from "@teldra/domain";
import {
  openProjectPersistence,
  encodeStoredZip, openTeldraArchive, readScenePlacementOverrides, replaceTeldraBuilding, sha256Bytes,
  type ProjectStorageAdapter,
  type StoredProject,
} from "@teldra/project-format";
import { StudioProjectController, validateIfcScenePlacements } from "./StudioProjectController";

class MemoryStorage implements ProjectStorageAdapter<TwinProject> {
  primary: StoredProject<TwinProject> | null;
  backup: StoredProject<TwinProject> | null = null;
  recovery: StoredProject<TwinProject> | null = null;
  staged: StoredProject<TwinProject> | null = null;
  locked = false;

  constructor(primary: StoredProject<TwinProject>) {
    this.primary = structuredClone(primary);
  }

  async acquireWriteLock(): Promise<boolean> {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  async releaseWriteLock(): Promise<void> {
    this.locked = false;
  }

  async readPrimary() {
    return structuredClone(this.primary);
  }

  async readBackup() {
    return structuredClone(this.backup);
  }

  async readRecovery() {
    return structuredClone(this.recovery);
  }

  async stagePrimary(
    _projectKey: string,
    _ownerId: string,
    project: StoredProject<TwinProject>,
  ): Promise<string> {
    this.staged = structuredClone(project);
    return "stage:1";
  }

  async commitStaged(): Promise<void> {
    if (this.staged === null) throw new Error("No staged project.");
    this.backup = structuredClone(this.primary);
    this.primary = structuredClone(this.staged);
    this.staged = null;
  }

  async discardStaged(): Promise<void> {
    this.staged = null;
  }

  async writeRecovery(
    _projectKey: string,
    _ownerId: string,
    project: StoredProject<TwinProject>,
  ): Promise<void> {
    this.recovery = structuredClone(project);
  }

  async clearRecovery(): Promise<void> {
    this.recovery = null;
  }
}

const fixture = goldenTwin as TwinProject;
const deviceId = "device:living-room-floor-lamp";

describe("StudioProjectController", () => {
  it("exposes synchronous view state without self-referential UI state", async () => {
    const storage = new MemoryStorage({
      revision: 2,
      fingerprint: canonicalTwinFingerprint(fixture),
      canonical: fixture,
    });

    const opened = await openProjectPersistence(
      storage,
      assertTwinIntegrity,
      "golden-home",
      "test:view-state",
    );

    expect(opened.primary).not.toBeNull();
    if (opened.primary === null) return;

    const controller = new StudioProjectController(
      opened.primary.canonical,
      opened.session,
    );

    expect(controller.dirty).toBe(false);
    expect(controller.revision).toBe(2);
    expect(controller.history.canUndo).toBe(false);

    controller.renameDevice(deviceId, "Reading lamp");

    expect(controller.dirty).toBe(true);
    expect(controller.revision).toBe(3);
    expect(controller.history.canUndo).toBe(true);
  });


  it("drives dirty state, undo/redo, and persistence without SolidJS authority", async () => {
    const storage = new MemoryStorage({
      revision: 4,
      fingerprint: canonicalTwinFingerprint(fixture),
      canonical: fixture,
    });

    const opened = await openProjectPersistence(
      storage,
      assertTwinIntegrity,
      "golden-home",
      "test:editor",
    );

    expect(opened.primary).not.toBeNull();
    if (opened.primary === null) return;

    const controller = new StudioProjectController(
      opened.primary.canonical,
      opened.session,
    );

    expect(controller.revision).toBe(4);
    expect(controller.dirty).toBe(false);

    controller.renameDevice(deviceId, "Reading lamp");
    expect(controller.revision).toBe(5);
    expect(controller.dirty).toBe(true);

    expect(controller.undo()).toBe(true);
    expect(controller.revision).toBe(6);
    expect(controller.dirty).toBe(false);

    expect(controller.redo()).toBe(true);
    expect(controller.revision).toBe(7);
    expect(controller.dirty).toBe(true);

    await controller.save();

    expect(controller.dirty).toBe(false);
    expect(storage.primary?.revision).toBe(7);
    expect(
      storage.primary?.canonical.devices.find(
        (device) => device.id === deviceId,
      )?.name,
    ).toBe("Reading lamp");
    expect(
      storage.primary?.canonical.bindings[0]?.externalId,
    ).toBe("light.living_room_floor_lamp");
  });

  it("keeps canonical selection session-owned and preserves it across rename", async () => {
    const storage = new MemoryStorage({
      revision: 2,
      fingerprint: canonicalTwinFingerprint(fixture),
      canonical: fixture,
    });

    const opened = await openProjectPersistence(
      storage,
      assertTwinIntegrity,
      "golden-home",
      "test:selection",
    );

    expect(opened.primary).not.toBeNull();
    if (opened.primary === null) return;

    const controller = new StudioProjectController(
      opened.primary.canonical,
      opened.session,
    );

    const initialRevision = controller.revision;
    const initialHistory = controller.history;

    controller.selectCanonicalId("wall:fixture");
    expect(controller.selectedCanonicalId).toBe("wall:fixture");
    expect(controller.selectedDevice).toBeUndefined();
    expect(controller.dirty).toBe(false);
    expect(controller.revision).toBe(initialRevision);
    expect(controller.history).toEqual(initialHistory);

    controller.selectCanonicalId(deviceId);
    expect(controller.selectedDevice?.id).toBe(deviceId);
    expect(controller.dirty).toBe(false);
    expect(controller.revision).toBe(initialRevision);
    expect(controller.history).toEqual(initialHistory);

    controller.renameDevice(deviceId, "Reading lamp");

    expect(controller.selectedCanonicalId).toBe(deviceId);
    expect(controller.selectedDevice?.name).toBe("Reading lamp");
    expect(controller.revision).toBe(initialRevision + 1);
    expect(controller.dirty).toBe(true);
  });

  it("orders IFC and twin edits in one history and saves both", async () => {
    const twin = structuredClone(fixture);
    const guid = "16W6mYG0DO8hR8U$bz6FSv";
    twin.building.refs.push({ id: "chair", ifcGlobalId: guid, kind: "furniture" });
    const storage = new MemoryStorage({ revision: 0, fingerprint: canonicalTwinFingerprint(twin), canonical: twin });
    const opened = await openProjectPersistence(storage, assertTwinIntegrity, "mixed", "test:mixed");
    const codec = new TextEncoder(), decoder = new TextDecoder();
    const initial = { position: [1, -1, 0] as [number,number,number], yawRadians: 0 };
    const controller = new StudioProjectController(twin, opened.session, {
      bytes: codec.encode(JSON.stringify(initial)), sourceBytes: codec.encode(JSON.stringify(initial)), placements: [],
      scene: { source: { buildingPath: "building.ifc", buildingSha256: "a".repeat(64) }, scene: { assetPath: "scene.glb", assetSha256: "b".repeat(64) }, nodes: [{ canonicalId: "chair", ifcGlobalId: guid }] },
      createAdapter: async () => ({ read: (bytes) => JSON.parse(decoder.decode(bytes)), write: (_bytes, _id, pose) => codec.encode(JSON.stringify(pose)) }),
    });
    await controller.prepareFurnitureEditing("chair");
    controller.renameDevice(deviceId, "Changed lamp");
    controller.placeFurniture("chair", { position: [2, 3, 1], yawRadians: Math.PI / 2 });
    expect(controller.placementOverrides[0]?.matrix[12]).toBeCloseTo(1);
    controller.undo(); expect(controller.furniturePose("chair")).toEqual(initial);
    controller.undo(); expect(controller.dirty).toBe(false);
    controller.redo(); controller.redo();
    await controller.save();
    expect(controller.dirty).toBe(false);
    expect(storage.primary?.canonical.devices.find((d) => d.id === deviceId)?.name).toBe("Changed lamp");
    const data = storage.primary?.derived as { bytes: Uint8Array };
    expect(JSON.parse(decoder.decode(data.bytes)).position).toEqual([2, 3, 1]);
    controller.undo(); expect(controller.dirty).toBe(true);
    controller.redo(); expect(controller.dirty).toBe(false);
  });

});


it("rejects a rendered placement that contradicts authoritative IFC poses", () => {
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const source = {position: [0,0,0] as const, yawRadians: 0};
  const current = {position: [2,0,0] as const, yawRadians: 0};
  const adapter = {read: (bytes: Uint8Array) => JSON.parse(decoder.decode(bytes)), write: (bytes: Uint8Array) => bytes};
  expect(() => validateIfcScenePlacements(adapter, encoder.encode(JSON.stringify(source)), encoder.encode(JSON.stringify(current)),
    [{canonicalId: "chair", ifcGlobalId: "16W6mYG0DO8hR8U$bz6FSv", matrix: [1,0,0,0,0,1,0,0,0,0,1,0,3,0,0,1]}])).toThrow("does not match");
});


it("commits geometry scale with pose as one IFC undo step and validates source-bound scene reconciliation", async () => {
  const twin = structuredClone(fixture);
  const guid = "16W6mYG0DO8hR8U$bz6FSv";
  twin.building.refs.push({id:"chair", ifcGlobalId:guid, kind:"furniture"});
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const original = {pose:{position:[1,-1,0] as [number,number,number], yawRadians:0}, scale:[1,1,1] as [number,number,number]};
  const decode = (bytes:Uint8Array) => JSON.parse(decoder.decode(bytes)) as typeof original;
  const adapter = {
    read: (bytes:Uint8Array) => decode(bytes).pose,
    write: (bytes:Uint8Array, _guid:string, pose: typeof original.pose) => encoder.encode(JSON.stringify({...decode(bytes),pose})),
    readScale: (bytes:Uint8Array) => decode(bytes).scale,
    writeScale: (bytes:Uint8Array, _guid:string, scale:readonly [number,number,number]) =>
      encoder.encode(JSON.stringify({...decode(bytes),scale})),
  };
  const bytes = encoder.encode(JSON.stringify(original));
  const store = new MemoryStorage({revision:0,fingerprint:canonicalTwinFingerprint(twin),canonical:twin});
  const opened = await openProjectPersistence(store, assertTwinIntegrity, "mapped-scale", "test:mapped-scale");
  const controller = new StudioProjectController(twin,opened.session,{
    bytes,sourceBytes:bytes,placements:[],
    scene:{source:{buildingPath:"building.ifc",buildingSha256:"a".repeat(64)},
      scene:{assetPath:"scene.glb",assetSha256:"b".repeat(64)},
      nodes:[{canonicalId:"chair",ifcGlobalId:guid}]},
    createAdapter:async()=>adapter,
  });
  await controller.prepareFurnitureEditing("chair");
  expect(controller.furnitureScaleStatus("chair")).toEqual({supported:true,scale:[1,1,1]});
  controller.transformFurniture("chair",{position:[2,3,1],yawRadians:0},[2,1.5,0.8]);
  expect(controller.history.undoDepth).toBe(1);
  const [placement] = controller.placementOverrides;
  expect(placement?.scale).toEqual([2,1.5,0.8]);
  expect(placement?.matrix[12]).toBeCloseTo(0);
  expect(placement?.matrix[13]).toBeCloseTo(4.5);
  const editedBytes = (decode(store.primary?.derived as Uint8Array ?? bytes));
  expect(editedBytes.scale).toEqual([1,1,1]); // Save is explicit.
  await controller.save();
  const persisted = (store.primary?.derived as {bytes:Uint8Array,placements:unknown[]});
  validateIfcScenePlacements(adapter,bytes,persisted.bytes,controller.placementOverrides);
  const altered = controller.placementOverrides.map(p=>({...p,scale:[3,1.5,0.8] as [number,number,number]}));
  expect(()=>validateIfcScenePlacements(adapter,bytes,persisted.bytes,altered)).toThrow(/geometry scale/);
  expect(controller.undo()).toBe(true);
  expect(controller.furnitureScaleStatus("chair")).toEqual({supported:true,scale:[1,1,1]});
  expect(controller.redo()).toBe(true);
  expect(controller.furnitureScaleStatus("chair")).toEqual({supported:true,scale:[2,1.5,0.8]});
});


it("roundtrips a real IFC4 mapped-instance scale through the canonical .teldra archive", async () => {
  const guid = "16W6mYG0DO8hR8U$bz6FSv";
  const originalLine = "#149=IFCFURNITURE('16W6mYG0DO8hR8U$bz6FSv',$,'Chair',$,$,#154,$,$,$);";
  const changedLine = "#149=IFCFURNITURE('16W6mYG0DO8hR8U$bz6FSv',$,'Chair',$,$,#154,#304,$,$);";
  if (!goldenIfc.includes(originalLine)) throw new Error("IFC golden furniture fixture has changed.");
  const representation = [
    "#300=IFCREPRESENTATIONMAP(#10,#64);",
    "#301=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#7,1.,$);",
    "#302=IFCMAPPEDITEM(#300,#301);",
    "#303=IFCSHAPEREPRESENTATION(#12,'Body','MappedRepresentation',(#302));",
    "#304=IFCPRODUCTDEFINITIONSHAPE($,$,(#303));",
  ].join("\n");
  const sourceIfc = goldenIfc.replace(originalLine, changedLine)
    .replace("\nENDSEC;\nEND-ISO-10303-21;", "\n" + representation + "\nENDSEC;\nEND-ISO-10303-21;");
  const encoder = new TextEncoder();
  const sourceBytes = encoder.encode(sourceIfc);
  const api = new IfcAPI();
  await api.Init();
  const adapter = {
    read: (bytes: Uint8Array, id: string) => readFurniturePose(api, bytes, id),
    write: (bytes: Uint8Array, id: string, pose: {position: readonly [number,number,number];yawRadians:number}) =>
      writeFurniturePose(api, bytes, id, pose),
    readScale: (bytes: Uint8Array, id: string) => readFurnitureGeometryScale(api, bytes, id),
    writeScale: (bytes: Uint8Array, id: string, scale: readonly [number,number,number]) =>
      writeFurnitureGeometryScale(api, bytes, id, scale),
  };
  const twin = structuredClone(fixture);
  twin.building.refs.push({id:"chair",ifcGlobalId:guid,kind:"furniture",name:"Chair"});
  const buildingHash = await sha256Bytes(sourceBytes);
  const twinBytes = encoder.encode(JSON.stringify(twin));
  const glb = new Uint8Array([5,6,7,8]);
  const glbHash = await sha256Bytes(glb);
  const manifest = {
    formatVersion: "0.1.0",
    building: {path:"building.ifc",sha256:buildingHash},
    twin: {path:"twin.json",sha256:await sha256Bytes(twinBytes)},
    derived: [],
  };
  const originalArchive = await openTeldraArchive(encodeStoredZip([
    {path:"project.json",bytes:encoder.encode(JSON.stringify(manifest))},
    {path:"building.ifc",bytes:sourceBytes},
    {path:"twin.json",bytes:twinBytes},
    {path:"scene.glb",bytes:glb},
  ]));
  const scene = {
    source:{buildingPath:"building.ifc",buildingSha256:buildingHash},
    scene:{assetPath:"scene.glb",assetSha256:glbHash},
    nodes:[{canonicalId:"chair",ifcGlobalId:guid}],
  };
  const storage = new MemoryStorage({revision:0,fingerprint:canonicalTwinFingerprint(twin),canonical:twin});
  const opened = await openProjectPersistence(storage,assertTwinIntegrity,"roundtrip-scale","test:real-ifc-scale");
  const controller = new StudioProjectController(twin,opened.session,{
    bytes:sourceBytes,sourceBytes,placements:[],scene,createAdapter:async()=>adapter,
  });
  await controller.prepareFurnitureEditing("chair");
  expect(controller.furnitureScaleStatus("chair")).toEqual({supported:true,scale:[1,1,1]});
  controller.transformFurniture("chair",{position:[2,3,1],yawRadians:0},[1.25,1.5,0.8]);
  expect(controller.history.undoDepth).toBe(1);
  await controller.save();
  const persisted = storage.primary?.derived as {
    bytes:Uint8Array;
    placements:readonly import("@teldra/project-format").ScenePlacementOverride[];
  } | undefined;
  if (!persisted) throw new Error("Scaled canonical IFC was not staged for persistence.");
  const stored = await replaceTeldraBuilding(originalArchive,persisted.bytes,scene,persisted.placements);
  const reopenedArchive = await openTeldraArchive(stored.bytes);
  const reconciled = await readScenePlacementOverrides(reopenedArchive,scene);
  expect(reconciled?.version).toBe(2);
  expect(reconciled?.placements[0]?.scale).toEqual([1.25,1.5,0.8]);
  const reopenedIfc = reopenedArchive.entries.find(entry=>entry.path==="building.ifc")?.bytes;
  if (!reopenedIfc) throw new Error("Reopened .teldra has no canonical building.");
  expect(readFurnitureGeometryScale(api,sourceBytes,guid)).toEqual([1,1,1]);
  expect(readFurnitureGeometryScale(api,reopenedIfc,guid)).toEqual([1.25,1.5,0.8]);
  const pose = readFurniturePose(api,reopenedIfc,guid);
  expect(pose.position).toEqual([2,3,1]);
  validateIfcScenePlacements(adapter,sourceBytes,reopenedIfc,reconciled!.placements);
  expect(reopenedArchive.manifest.building.sha256).toBe(await sha256Bytes(reopenedIfc));
  controller.undo();
  expect(controller.furnitureScaleStatus("chair")).toEqual({supported:true,scale:[1,1,1]});
  controller.redo();
  expect(controller.furnitureScaleStatus("chair")).toEqual({supported:true,scale:[1.25,1.5,0.8]});
  await opened.session.close();
});
