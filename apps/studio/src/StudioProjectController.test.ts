import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import goldenIfc from "../../../fixtures/projects/golden-home/building.ifc?raw";
import { IfcAPI } from "web-ifc";
import { readFurniturePose, writeFurniturePose, readFurnitureGeometryScale, writeFurnitureGeometryScale, readFurnitureSourceDimensions } from "@teldra/ifc-edit";
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
  expect(controller.furnitureMeasuredSizeStatus("chair",[0.4,0.8,1.2])).toEqual({
    supported:true,source:[0.4,0.8,1.2],current:[0.4,0.8,1.2],
  });
  const measuredFactors=controller.furnitureScaleForMeasuredSize("chair",
    [0.4,0.8,1.2],[0.8,1.2,0.96]);
  measuredFactors.forEach((value,index)=>
    expect(value).toBeCloseTo([2,1.5,0.8][index]!,9));
  controller.transformFurniture("chair",{position:[2,3,1],yawRadians:0},[2,1.5,0.8]);
  const actualMeasured=controller.furnitureMeasuredSizeStatus("chair",[0.4,0.8,1.2]);
  expect(actualMeasured.supported).toBe(true);
  if (actualMeasured.supported)
    actualMeasured.current.forEach((value,index)=>
      expect(value).toBeCloseTo([0.8,1.2,0.96][index]!,8));
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
  const shearedPose={position:[2,3,1] as const,yawRadians:Math.PI/4};
  // This fixture's original yaw is zero, so its canonical delta remains
  // decomposable; attaching a renderer nevertheless preflights nonuniform
  // scale for potentially rotated *mesh-local* source parts.
  let validated=0;
  controller.setAffineProjectionValidator((id,matrix)=>{
    expect(id).toBe("chair");
    expect(matrix).toHaveLength(16);
    validated++;
  });
  controller.transformFurniture("chair",shearedPose,[2,1,1]);
  expect(validated).toBe(1);
  expect(controller.furniturePose("chair").yawRadians).toBeCloseTo(Math.PI/4);
  expect(controller.undo()).toBe(true);
  expect(controller.furnitureScaleStatus("chair")).toEqual({supported:true,scale:[2,1.5,0.8]});
  controller.setAffineProjectionValidator(null);
});


it("roundtrips a real IFC4 mapped-instance scale through the canonical .teldra archive", async () => {
  const guid = "16W6mYG0DO8hR8U$bz6FSv";
  const originalLine = "#203=IFCFURNITURE('16W6mYG0DO8hR8U$bz6FSv',$,'Chair',$,$,#208,$,$,$);";
  const changedLine = "#203=IFCFURNITURE('16W6mYG0DO8hR8U$bz6FSv',$,'Chair',$,$,#208,#304,$,$);";
  if (!goldenIfc.includes(originalLine)) throw new Error("IFC golden furniture fixture has changed.");
  const representation = [
    "#300=IFCREPRESENTATIONMAP(#10,#57);",
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
    readSourceDimensions: (bytes: Uint8Array, id: string) => readFurnitureSourceDimensions(api, bytes, id),
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
  expect(controller.furnitureDimensionStatus("chair")).toEqual({
    supported:true,source:[0.5,0.5,1],current:[0.5,0.5,1],
  });
  const authoredScale = controller.furnitureScaleForDimensions("chair",[0.625,0.75,0.8]);
  expect(authoredScale).toEqual([1.25,1.5,0.8]);
  controller.transformFurniture("chair",{position:[2,3,1],yawRadians:0},authoredScale);
  expect(controller.furnitureDimensionStatus("chair")).toEqual({
    supported:true,source:[0.5,0.5,1],current:[0.625,0.75,0.8],
  });
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
  expect(readFurnitureSourceDimensions(api,sourceBytes,guid)).toEqual([0.5,0.5,1]);
  expect(readFurnitureSourceDimensions(api,reopenedIfc,guid)).toEqual([0.5,0.5,1]);
  const pose = readFurniturePose(api,reopenedIfc,guid);
  expect(pose.position).toEqual([2,3,1]);
  validateIfcScenePlacements(adapter,sourceBytes,reopenedIfc,reconciled!.placements);
  expect(reopenedArchive.manifest.building.sha256).toBe(await sha256Bytes(reopenedIfc));
  controller.undo();
  expect(controller.furnitureScaleStatus("chair")).toEqual({supported:true,scale:[1,1,1]});
  expect(controller.furnitureDimensionStatus("chair").supported).toBe(true);
  controller.redo();
  expect(controller.furnitureScaleStatus("chair")).toEqual({supported:true,scale:[1.25,1.5,0.8]});
  await opened.session.close();
});


describe("StudioProjectController furniture lifecycle", () => {
  interface Doc { elements: Record<string, { pose: { position: [number, number, number]; yawRadians: number }; name: string }> }
  const enc = new TextEncoder(), dec = new TextDecoder();
  const put = (d: Doc) => enc.encode(JSON.stringify(d)), get = (b: Uint8Array) => JSON.parse(dec.decode(b)) as Doc;
  const chairGuid = "16W6mYG0DO8hR8U$bz6FSv", lampGuid = "0ufYQjmwP0Ah$QRRxVbqR3";
  const adapter = {
    read: (b: Uint8Array, id: string) => { const e = get(b).elements[id]; if (!e) throw new Error("missing " + id); return e.pose; },
    write: (b: Uint8Array, id: string, pose: any) => { const d = get(b); d.elements[id]!.pose = pose; return put(d); },
    duplicate: (b: Uint8Array, id: string, newId: string, o?: { offset?: readonly number[]; name?: string }) => {
      const d = get(b); const s = d.elements[id]!; const off = o?.offset ?? [0, 0, 0];
      d.elements[newId] = { name: o?.name ?? s.name, pose: { position: [s.pose.position[0] + off[0]!, s.pose.position[1] + off[1]!, s.pose.position[2] + off[2]!], yawRadians: s.pose.yawRadians } };
      return put(d);
    },
    remove: (b: Uint8Array, id: string) => { const d = get(b); delete d.elements[id]; return put(d); },
  };
  async function setup(ifc: any = adapter) {
    const twin = structuredClone(fixture); twin.building.refs.push({ id: "chair", ifcGlobalId: chairGuid, kind: "furniture", name: "Chair" });
    const storage = new MemoryStorage({ revision: 0, fingerprint: canonicalTwinFingerprint(twin), canonical: twin });
    const opened = await openProjectPersistence(storage, assertTwinIntegrity, "life", "test:life");
    const doc: Doc = { elements: { [chairGuid]: { name: "Chair", pose: { position: [1, -1, 0], yawRadians: 0 } }, [lampGuid]: { name: "Lamp", pose: { position: [2, 2, 0], yawRadians: 0 } } } };
    const controller = new StudioProjectController(twin, opened.session, {
      bytes: put(doc), sourceBytes: put(doc), placements: [],
      scene: { source: { buildingPath: "building.ifc", buildingSha256: "a".repeat(64) }, scene: { assetPath: "scene.glb", assetSha256: "b".repeat(64) },
        nodes: [{ canonicalId: "chair", ifcGlobalId: chairGuid }, { canonicalId: "fixture:living-room-floor-lamp", ifcGlobalId: lampGuid }] },
      createAdapter: async () => ifc,
    });
    return { controller, storage };
  }

  it("duplicates with a new canonical identity and GlobalId, copy name and offset, as one undoable step", async () => {
    const { controller } = await setup();
    const before = structuredClone(controller.twin); const depth = controller.history.undoDepth;
    const copyId = await controller.duplicateFurniture("chair");
    expect(copyId).toBe("chair-copy");
    const ref = controller.twin.building.refs.find(r => r.id === copyId)!;
    expect(ref.ifcGlobalId).not.toBe(chairGuid); expect(ref.ifcGlobalId).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
    expect(ref.kind).toBe("furniture"); expect(ref.name).toBe("Chair (copy)");
    expect(controller.history.undoDepth).toBe(depth + 1);
    expect(controller.furniturePose(copyId).position[0]).toBeCloseTo(1.5);
    expect(controller.furniturePose("chair").position).toEqual([1, -1, 0]);
    controller.undo();
    expect(controller.twin).toEqual(before); expect(controller.dirty).toBe(false);
    controller.redo();
    expect(controller.twin.building.refs.some(r => r.id === copyId)).toBe(true);
  });

  it("drops a selection that undo of the duplicate made stale", async () => {
    const { controller } = await setup();
    const copyId = await controller.duplicateFurniture("chair");
    controller.selectCanonicalId(copyId);
    controller.undo();
    expect(controller.selectedCanonicalId).toBeNull();
  });

  it("does not inherit device bindings: copying a bound lamp adds no device, capability or binding", async () => {
    const { controller } = await setup();
    const devices = structuredClone(controller.twin.devices), bindings = structuredClone(controller.twin.bindings);
    const copyId = await controller.duplicateFurniture("fixture:living-room-floor-lamp");
    expect(copyId).not.toBe("fixture:living-room-floor-lamp");
    expect(controller.twin.devices).toEqual(devices);
    expect(controller.twin.bindings).toEqual(bindings);
    expect(controller.twin.devices.some(d => d.buildingRefId === copyId)).toBe(false);
    const ids = [...controller.twin.building.refs.map(r => r.id), ...controller.twin.devices.map(d => d.id), ...controller.twin.bindings.map(b => b.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(controller.twin.bindings)).not.toContain(copyId);
  });

  it("removes furniture, clears selection, and undo/redo restores IFC bytes and twin together", async () => {
    const { controller } = await setup();
    await controller.prepareFurnitureEditing("chair"); controller.selectCanonicalId("chair");
    await controller.removeFurniture("chair");
    expect(controller.twin.building.refs.some(r => r.id === "chair")).toBe(false);
    expect(controller.selectedCanonicalId).toBeNull();
    expect(controller.removedSceneNodeIds).toEqual(["chair"]);
    controller.undo();
    expect(controller.twin.building.refs.some(r => r.id === "chair")).toBe(true);
    expect(controller.furniturePose("chair").position).toEqual([1, -1, 0]);
    expect(controller.removedSceneNodeIds).toEqual([]);
    controller.redo();
    expect(controller.twin.building.refs.some(r => r.id === "chair")).toBe(false);
  });

  it("vetoes removing a device-bound fixture before any IFC change", async () => {
    const { controller } = await setup();
    await controller.prepareFurnitureEditing("fixture:living-room-floor-lamp");
    const depth = controller.history.undoDepth;
    await expect(controller.removeFurniture("fixture:living-room-floor-lamp")).rejects.toThrow(/device:living-room-floor-lamp/);
    expect(controller.history.undoDepth).toBe(depth); expect(controller.dirty).toBe(false);
  });

  it("leaves twin and history unchanged if IFC removal is refused", async () => {
    const { controller } = await setup({ ...adapter, remove: () => { throw new Error("unsupported-relation: IfcRelAssignsToGroup"); } });
    await controller.prepareFurnitureEditing("chair");
    const before = structuredClone(controller.twin);
    await expect(controller.removeFurniture("chair")).rejects.toThrow(/IfcRelAssignsToGroup/);
    expect(controller.twin).toEqual(before); expect(controller.dirty).toBe(false);
  });

  it("saves a copy that has no scene geometry: IFC and twin carry it, but no placement override is invented", async () => {
    const { controller, storage } = await setup();
    const copyId = await controller.duplicateFurniture("chair");
    await controller.prepareFurnitureEditing(copyId);
    controller.placeFurniture(copyId, { position: [3, 3, 0], yawRadians: 0 });
    expect(controller.isSceneBacked(copyId)).toBe(false);
    expect(controller.placementOverrides.map(p => p.canonicalId)).not.toContain(copyId);
    await controller.save();
    const saved = storage.primary!; const copyGuid = saved.canonical.building.refs.find(r => r.id === copyId)!.ifcGlobalId;
    expect(get((saved.derived as { bytes: Uint8Array }).bytes).elements[copyGuid]!.pose.position).toEqual([3, 3, 0]);
  });
});
