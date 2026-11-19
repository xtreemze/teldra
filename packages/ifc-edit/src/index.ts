import { IfcAPI, IFCRELFILLSELEMENT, IFCLIGHTFIXTURE, IFCBUILDINGELEMENTPROXY, IFCFURNITURE, IFCPROJECT, IFCSIUNIT, IFCLOCALPLACEMENT, IFCAXIS2PLACEMENT3D, IFCCARTESIANPOINT, IFCDIRECTION, IFCLENGTHMEASURE, IFCREAL, IFCPRODUCT, IFCPRODUCTDEFINITIONSHAPE, IFCSHAPEREPRESENTATION, IFCMAPPEDITEM, IFCREPRESENTATIONMAP, IFCCARTESIANTRANSFORMATIONOPERATOR3D, IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM, IFCRELDEFINESBYPROPERTIES, IFCPROPERTYSET, IFCPROPERTYSINGLEVALUE, IFCTRIANGULATEDFACESET, IFCCARTESIANPOINTLIST3D } from "web-ifc";
import { IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELDEFINESBYTYPE, IFCRELASSOCIATES, IFCRELATIONSHIP, IFCROOT, IFCSTYLEDITEM, IFCPRESENTATIONLAYERASSIGNMENT, IFCGEOMETRICREPRESENTATIONCONTEXT, IFCGEOMETRICREPRESENTATIONSUBCONTEXT, IFCOWNERHISTORY, IFCGLOBALLYUNIQUEID, IFCLABEL, Handle } from "web-ifc";
import * as ifcTypes from "web-ifc";
import { chain, epsilon, model, numeric, type FurniturePose, type Line } from "./ifc-session.js";
import { indexOf, type InverseSnapshot } from "./session-core.js";
export * from "./edit-session.js";
export type { FurniturePose } from "./ifc-session.js";
export * from "./wall.js";
export * from "./tessellation.js";

function find(api: IfcAPI, modelID: number, guid: string): Line {
  const found: Line[] = [];
  for (const type of [IFCFURNITURE, IFCLIGHTFIXTURE, IFCBUILDINGELEMENTPROXY]) {
    const ids = api.GetLineIDsWithType(modelID, type);
    for (let i=0;i<ids.size();i++) { const line=api.GetLine(modelID,ids.get(i)) as Line; if(line.GlobalId?.value===guid) found.push(line); }
  }
  if(found.length!==1) throw new Error("Expected one supported IFC furniture, fixture or proxy GlobalId.");
  const furniture = found[0]!;
  const fillings = api.GetLineIDsWithType(modelID, IFCRELFILLSELEMENT);
  for(let i=0;i<fillings.size();i++) {
    if((api.GetLine(modelID, fillings.get(i)) as Line).RelatedBuildingElement?.value === furniture.expressID)
      throw new Error("An element filling an IFC opening requires host-aware editing.");
  }
  const placementId = furniture.ObjectPlacement?.value;
  const placements = api.GetLineIDsWithType(modelID, IFCLOCALPLACEMENT);
  for (let i = 0; i < placements.size(); i++) {
    const candidate = api.GetLine(modelID, placements.get(i)) as Line;
    if (candidate.PlacementRelTo?.value === placementId) throw new Error("Furniture with dependent IFC placements cannot be edited safely.");
  }
  return furniture;
}
export function readFurniturePose(api: IfcAPI, bytes: Uint8Array, guid: string): FurniturePose {
  return model(api, bytes, (id, api) => chain(api, id, find(api, id, guid).ObjectPlacement).pose);
}
function applyPose(api: IfcAPI, id: number, furniture: Line, pose: FurniturePose): void {
  const { parent, relativeParent } = chain(api, id, furniture.ObjectPlacement);
  const dx = pose.position[0] - parent.position[0], dy = pose.position[1] - parent.position[1];
  const c = Math.cos(parent.yawRadians), s = Math.sin(parent.yawRadians), yaw = pose.yawRadians - parent.yawRadians;
  const number = (value: number) => api.CreateIfcType(id, IFCLENGTHMEASURE, value);
  const real = (value: number) => api.CreateIfcType(id, IFCREAL, value);
  const point = api.CreateIfcEntity(id, IFCCARTESIANPOINT, [number(c * dx + s * dy), number(-s * dx + c * dy), number(pose.position[2] - parent.position[2])]);
  const axis = api.CreateIfcEntity(id, IFCDIRECTION, [real(0), real(0), real(1)]);
  const direction = api.CreateIfcEntity(id, IFCDIRECTION, [real(Math.cos(yaw)), real(Math.sin(yaw)), real(0)]);
  const relative = api.CreateIfcEntity(id, IFCAXIS2PLACEMENT3D, point, axis, direction);
  furniture.ObjectPlacement = api.CreateIfcEntity(id, IFCLOCALPLACEMENT, relativeParent, relative);
  api.WriteLine(id, furniture);
}
export function writeFurniturePose(api: IfcAPI, bytes: Uint8Array, guid: string, pose: FurniturePose): Uint8Array {
  if (pose.position.length !== 3 || ![...pose.position, pose.yawRadians].every(Number.isFinite)) throw new Error("Furniture pose must be finite.");
  return model(api, bytes, (id, api) => {
    applyPose(api, id, find(api, id, guid), pose);
    return api.SaveModel(id);
  });
}


/** IFC4 per-instance mapped geometry scaling, in local XYZ; never a placement scale. */
export type FurnitureGeometryScale = readonly [number, number, number];
function validGeometryScale(scale: readonly number[]): asserts scale is FurnitureGeometryScale {
  if (scale.length !== 3 || scale.some(value => !Number.isFinite(value) || value <= 0 || value > 1000))
    throw new Error("Furniture scale must contain three finite, positive factors at most 1000.");
}
const nearTuple = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < 1e-8);
function handle(ref: any, label: string): number {
  if (!Number.isInteger(ref?.value) || ref.value <= 0) throw new Error("Missing " + label + ".");
  return ref.value;
}
function zeroPoint(api: IfcAPI, id: number, ref: any, label: string) {
  const point = api.GetLine(id, handle(ref, label)) as Line;
  if (point?.type !== IFCCARTESIANPOINT || !nearTuple(numeric(point.Coordinates, label), [0,0,0]))
    throw new Error(label + " must be at the local origin.");
}
function identityDirection(api: IfcAPI, id: number, ref: any, expected: number[], label: string) {
  if (!ref) return;
  const axis = api.GetLine(id, handle(ref, label)) as Line;
  if (axis?.type !== IFCDIRECTION || !nearTuple(numeric(axis.DirectionRatios, label), expected))
    throw new Error("Only identity-aligned geometry mapping is supported (" + label + ").");
}
/**
 * The mapped source geometry may be shared. The editable product definition,
 * shape and mapped item may not; only a fresh MappingTarget will be committed.
 */
function mappedFurniture(api: IfcAPI, id: number, guid: string): { item: Line; scale: FurnitureGeometryScale } {
  const furniture = find(api, id, guid);
  const definitionId = handle(furniture.Representation, "IfcProductDefinitionShape");
  const definition = api.GetLine(id, definitionId) as Line;
  if (definition?.type !== IFCPRODUCTDEFINITIONSHAPE || definition.Representations?.length !== 1)
    throw new Error("Scale requires one owned IFC product shape representation.");
  const shapeId = handle(definition.Representations[0], "IfcShapeRepresentation");
  const shape = api.GetLine(id, shapeId) as Line;
  if (shape?.type !== IFCSHAPEREPRESENTATION || shape.RepresentationIdentifier?.value !== "Body" ||
      shape.RepresentationType?.value !== "MappedRepresentation" || shape.Items?.length !== 1)
    throw new Error("Only a Body/MappedRepresentation with one mapped item supports scaling.");
  const itemId = handle(shape.Items[0], "IfcMappedItem");
  const item = api.GetLine(id, itemId) as Line;
  if (item?.type !== IFCMAPPEDITEM) throw new Error("Expected a single IfcMappedItem.");

  // Guard each level of the editable reference chain against other products.
  const products = api.GetLineIDsWithType(id, IFCPRODUCT, true);
  let productOwners = 0;
  for (let i = 0; i < products.size(); i++)
    if ((api.GetLine(id, products.get(i)) as Line).Representation?.value === definitionId) productOwners++;
  if (productOwners !== 1) throw new Error("Product geometry is shared by another IFC product.");
  const definitions = api.GetLineIDsWithType(id, IFCPRODUCTDEFINITIONSHAPE);
  let shapeOwners = 0;
  for (let i = 0; i < definitions.size(); i++)
    if ((api.GetLine(id, definitions.get(i)) as Line).Representations?.some((v: any) => v.value === shapeId)) shapeOwners++;
  if (shapeOwners !== 1) throw new Error("IFC shape is shared by another product definition.");
  const shapes = api.GetLineIDsWithType(id, IFCSHAPEREPRESENTATION);
  let mappedOwners = 0;
  for (let i = 0; i < shapes.size(); i++)
    if ((api.GetLine(id, shapes.get(i)) as Line).Items?.some((v: any) => v.value === itemId)) mappedOwners++;
  if (mappedOwners !== 1) throw new Error("Mapped item is shared by another IFC shape.");

  const source = api.GetLine(id, handle(item.MappingSource, "IfcRepresentationMap")) as Line;
  if (source?.type !== IFCREPRESENTATIONMAP) throw new Error("Expected IfcRepresentationMap.");
  const origin = api.GetLine(id, handle(source.MappingOrigin, "representation map origin")) as Line;
  if (origin?.type !== IFCAXIS2PLACEMENT3D) throw new Error("Only 3D mapping origins are supported.");
  zeroPoint(api, id, origin.Location, "mapping origin");
  identityDirection(api, id, origin.Axis, [0,0,1], "mapping Z");
  identityDirection(api, id, origin.RefDirection, [1,0,0], "mapping X");

  const target = api.GetLine(id, handle(item.MappingTarget, "mapping target")) as Line;
  if (target?.type !== IFCCARTESIANTRANSFORMATIONOPERATOR3D &&
      target?.type !== IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM)
    throw new Error("Only 3D mapping targets support scaling.");
  zeroPoint(api, id, target.LocalOrigin, "mapping target origin");
  identityDirection(api, id, target.Axis1, [1,0,0], "target X");
  identityDirection(api, id, target.Axis2, [0,1,0], "target Y");
  identityDirection(api, id, target.Axis3, [0,0,1], "target Z");
  const x = target.Scale?.value ?? 1;
  const scale: FurnitureGeometryScale = [x, target.Scale2?.value ?? x, target.Scale3?.value ?? x];
  validGeometryScale(scale);
  return { item, scale };
}
/**
 * Immutable *source* IFC geometry signature for the browser GLB rebake.
 * Unlike scene dimensions or MappingTarget factors, this includes every
 * triangulated face and coordinate of the shared source representation.
 * The signature intentionally excludes the mutable per-instance scale and
 * placement. It is only compared within the same import/rebase transaction.
 */
export function readFurnitureTessellationSignature(
  api: IfcAPI, bytes: Uint8Array, guid: string,
): string {
  return model(api, bytes, (id, api) => {
    const { item } = mappedFurniture(api, id, guid);
    const map = api.GetLine(id, handle(item.MappingSource, "IFC representation map")) as Line;
    const shape = api.GetLine(id, handle(map.MappedRepresentation, "mapped source representation")) as Line;
    if (shape?.type !== IFCSHAPEREPRESENTATION ||
        shape.RepresentationIdentifier?.value !== "Body" ||
        shape.RepresentationType?.value !== "Tessellation" ||
        shape.Items?.length !== 1)
      throw new Error("Rebake requires a single source Body/Tessellation representation.");
    const faceSet = api.GetLine(id, handle(shape.Items[0], "IfcTriangulatedFaceSet")) as Line;
    if (faceSet?.type !== IFCTRIANGULATEDFACESET)
      throw new Error("Rebake requires an IfcTriangulatedFaceSet source.");
    const points = api.GetLine(id, handle(faceSet.Coordinates, "IfcCartesianPointList3D")) as Line;
    if (points?.type !== IFCCARTESIANPOINTLIST3D ||
        !Array.isArray(points.CoordList) || points.CoordList.length < 3 ||
        !Array.isArray(faceSet.CoordIndex) || faceSet.CoordIndex.length === 0)
      throw new Error("Rebake requires complete indexed source triangle coordinates.");
    const representation = {
      coordinates: points.CoordList,
      indices: faceSet.CoordIndex,
      normals: faceSet.Normals ?? null,
      pnIndex: faceSet.PnIndex ?? null,
      closed: faceSet.Closed ?? null,
    };
    return JSON.stringify(representation);
  });
}

export function readFurnitureGeometryScale(api: IfcAPI, bytes: Uint8Array, guid: string): FurnitureGeometryScale {
  return model(api, bytes, (id, api) => mappedFurniture(api, id, guid).scale);
}
/** Updates only a fresh per-instance MappingTarget, never shared map geometry or stable identity. */
export function writeFurnitureGeometryScale(api: IfcAPI, bytes: Uint8Array, guid: string,
  scale: FurnitureGeometryScale): Uint8Array {
  validGeometryScale(scale);
  return model(api, bytes, (id, api) => {
    const { item } = mappedFurniture(api, id, guid);
    const real = (v: number) => api.CreateIfcType(id, IFCREAL, v);
    const origin = api.CreateIfcEntity(id, IFCCARTESIANPOINT,
      [0,0,0].map(v => api.CreateIfcType(id, IFCLENGTHMEASURE, v)));
    item.MappingTarget = api.CreateIfcEntity(id, IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM,
      null, null, origin, real(scale[0]), null, real(scale[1]), real(scale[2]));
    api.WriteLine(id, item);
    return api.SaveModel(id);
  });
}


/**
 * The immutable source-authored *nominal* SH3D dimensions (width, depth, height),
 * expressed in IFC local X/Y/Z metres. These are not measured mesh bounds and
 * are never rewritten by Scale. A current authored size is the nominal size
 * times the current/source IFC MappingTarget ratio.
 */
export type FurnitureSourceDimensions = readonly [number, number, number];

/**
 * Returns null for other native-IFC origins. Malformed or ambiguous Teldra
 * source provenance fails closed so a renderer cannot accidentally claim that
 * arbitrary mesh bounds are source-authored physical dimensions.
 */
export function readFurnitureSourceDimensions(
  api: IfcAPI, bytes: Uint8Array, guid: string,
): FurnitureSourceDimensions | null {
  return model(api, bytes, (id, api) => {
    const furniture = find(api, id, guid);
    const relations = api.GetLineIDsWithType(id, IFCRELDEFINESBYPROPERTIES);
    const sourceSets: Line[] = [];
    for (let i = 0; i < relations.size(); i++) {
      const relation = api.GetLine(id, relations.get(i)) as Line;
      if (!relation.RelatedObjects?.some((ref: any) => ref.value === furniture.expressID)) continue;
      const setRef = relation.RelatingPropertyDefinition;
      if (!Number.isInteger(setRef?.value)) continue;
      const pset = api.GetLine(id, setRef.value) as Line;
      if (pset?.type === IFCPROPERTYSET && pset.Name?.value === "Teldra_Source") {
        if (relation.RelatedObjects?.length !== 1)
          throw new Error("Shared SH3D source provenance cannot define one object's dimensions.");
        sourceSets.push(pset);
      }
    }
    if (!sourceSets.length) return null;
    if (sourceSets.length !== 1) throw new Error("Duplicate SH3D source provenance property sets.");
    const source = new Map<string, Line>();
    for (const ref of sourceSets[0]!.HasProperties ?? []) {
      const value = api.GetLine(id, ref.value) as Line;
      if (value?.type !== IFCPROPERTYSINGLEVALUE) continue;
      const name = value.Name?.value;
      if (typeof name !== "string") continue;
      if (source.has(name)) throw new Error("Duplicate source provenance property: " + name);
      source.set(name, value);
    }
    if (source.get("SourceSystem")?.NominalValue?.value !== "Sweet Home 3D") return null;
    if (source.get("SourceCoordinateFrame")?.NominalValue?.value !== "SH3D_PLAN_CM" ||
        source.get("ImportTransform")?.NominalValue?.value !== "X=x;Y=-y;Z=elevation")
      throw new Error("Unsupported SH3D dimension coordinate frame.");
    const readLength = (name: string): number => {
      const value = source.get(name)?.NominalValue;
      if (typeof value?.value !== "number" ||
          !Number.isFinite(value.value) || value.value <= 0 || value.value > 1000)
        throw new Error("Invalid or missing SH3D source dimension: " + name);
      return value.value;
    };
    return [
      readLength("SourceWidthMetres"),
      readLength("SourceDepthMetres"),
      readLength("SourceHeightMetres"),
    ];
  });
}


// ---------------------------------------------------------------------------
// Furniture lifecycle: duplicate and remove. IFC bytes in, new IFC bytes out.
// ---------------------------------------------------------------------------

export type FurnitureLifecycleErrorCode =
  | "not-found" | "invalid-global-id" | "duplicate-global-id"
  | "hosted-element" | "dependent-placement" | "unsupported-relation" | "unsupported-model";
/** Explicit, machine-readable refusal. The input bytes are never modified. */
export class FurnitureLifecycleError extends Error {
  readonly code: FurnitureLifecycleErrorCode;
  constructor(code: FurnitureLifecycleErrorCode, message: string, cause?: unknown) { super(message, cause === undefined ? undefined : { cause }); this.name = "FurnitureLifecycleError"; this.code = code; }
}
/** Compressed IFC GlobalId: 22 chars of [0-9A-Za-z_$], first char 0-3 (128 bits). */
const GLOBAL_ID_PATTERN = /^[0-3][0-9A-Za-z_$]{21}$/;
const BASE64_IFC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
/** Deterministic, valid IFC GlobalId derived from a seed GlobalId and a label (for owned relations/property sets). */
export function deriveGlobalId(seed: string, label: string, attempt = 0): string {
  const mask = (1n << 64n) - 1n;
  const fnv = (offset: bigint) => { let h = offset; for (const ch of `${seed}|${label}|${attempt}`) { h ^= BigInt(ch.codePointAt(0)!); h = (h * 0x100000001b3n) & mask; } return h; };
  const value = (fnv(0xcbf29ce484222325n) << 64n) | fnv(0x84222325cbf29ce4n);
  let text = BASE64_IFC[Number((value >> 126n) & 3n)]!;
  for (let shift = 120n; shift >= 0n; shift -= 6n) text += BASE64_IFC[Number((value >> shift) & 63n)]!;
  return text;
}

const sharedGeometryTypes = new Set<number>([IFCGEOMETRICREPRESENTATIONCONTEXT, IFCGEOMETRICREPRESENTATIONSUBCONTEXT,
  IFCREPRESENTATIONMAP, IFCOWNERHISTORY, IFCSIUNIT]);
const bookkeeping = new Set(["expressID", "type"]);

function lifecycleFind(api: IfcAPI, id: number, guid: string): Line {
  try { return find(api, id, guid); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code: FurnitureLifecycleErrorCode = message.includes("host-aware") ? "hosted-element"
      : message.includes("dependent IFC placements") ? "dependent-placement"
      : message.startsWith("Expected one") ? "not-found" : "unsupported-model";
    throw new FurnitureLifecycleError(code, message);
  }
}
function lifecycleModel<T>(api: IfcAPI, bytes: Uint8Array, run: (id: number, api: IfcAPI) => T): T {
  try { return model(api, bytes, run); }
  catch (error) {
    if (error instanceof FurnitureLifecycleError) throw error;
    throw new FurnitureLifecycleError("unsupported-model", error instanceof Error ? error.message : String(error), error);
  }
}
function childRefs(value: any, out: number[] = []): number[] {
  if (Array.isArray(value)) value.forEach(item => childRefs(item, out));
  else if (value && value.type === 5 && Number.isInteger(value.value)) out.push(value.value);
  return out;
}
const lineRefs = (line: Line): number[] =>
  childRefs(Object.entries(line).filter(([key]) => !bookkeeping.has(key)).map(([, value]) => value));
/** inverse.get(target) = ascending ids of lines that hold a reference to target (session-indexed snapshot). */
function inverseReferences(api: IfcAPI, _id: number): InverseSnapshot { return indexOf(api).snapshot(); }
function typeSet(api: IfcAPI, id: number, type: number): Set<number> {
  const ids = api.GetLineIDsWithType(id, type, true); const set = new Set<number>();
  for (let i = 0; i < ids.size(); i++) set.add(ids.get(i)); return set;
}
function takenGlobalIds(api: IfcAPI, id: number): Set<string> {
  const taken = new Set<string>(); const ids = api.GetLineIDsWithType(id, IFCROOT, true);
  for (let i = 0; i < ids.size(); i++) { const g = (api.GetLine(id, ids.get(i)) as Line).GlobalId?.value; if (typeof g === "string") taken.add(g); }
  return taken;
}

export interface DuplicateFurnitureOptions {
  /** World-frame (IFC metres, Z up) displacement of the copy from the source; default none. */
  readonly offset?: readonly [number, number, number];
  /** Optional name for the copy; defaults to the source name. */
  readonly name?: string;
}
/**
 * Copies one furniture/fixture/proxy element under a caller-supplied GlobalId.
 * The copy keeps the source's spatial containment, type and material (and other
 * IfcRelAssociates) memberships, gets its own placement and owned geometry
 * instances (shared IfcRepresentationMap sources stay shared), and a deep copy
 * of single-object property sets (e.g. Teldra_Source provenance).
 * Relations of other kinds (groups, connections, aggregates) are not copied.
 */
export function duplicateFurniture(api: IfcAPI, bytes: Uint8Array, sourceGuid: string, newGuid: string,
  options: DuplicateFurnitureOptions = {}): Uint8Array {
  if (!GLOBAL_ID_PATTERN.test(newGuid)) throw new FurnitureLifecycleError("invalid-global-id", "A compressed 22-character IFC GlobalId is required for the copy.");
  const offset = options.offset ?? [0, 0, 0];
  if (offset.length !== 3 || !offset.every(Number.isFinite)) throw new FurnitureLifecycleError("unsupported-model", "Duplicate offset must be three finite metres.");
  return lifecycleModel(api, bytes, (id, api) => {
    const source = lifecycleFind(api, id, sourceGuid);
    const taken = takenGlobalIds(api, id);
    if (taken.has(newGuid)) throw new FurnitureLifecycleError("duplicate-global-id", "The IFC GlobalId is already used by another entity.");
    const inverse = inverseReferences(api, id);
    const relationships = typeSet(api, id, IFCRELATIONSHIP);
    const associates = typeSet(api, id, IFCRELASSOCIATES);
    const memo = new Map<number, number>();
    const derived = (label: string) => { let attempt = 0, value: string; do value = deriveGlobalId(newGuid, label, attempt++); while (taken.has(value)); taken.add(value); return value; };
    // web-ifc reads typed values (IfcLabel, IfcLengthMeasure, ...) as wrapper instances whose browser build cannot be written back
    // directly; re-create each through the API so the copy is written identically in Node and the browser.
    const retype = (value: any): any => Array.isArray(value) ? value.map(retype)
      : value && typeof value === "object" && value.type !== 5 && typeof value.name === "string" && (ifcTypes as any)[value.name] !== undefined && "value" in value
        ? api.CreateIfcType(id, (ifcTypes as any)[value.name], value.value) : value;
    const write = (line: any): number => {
      for (const key of Object.keys(line)) if (!bookkeeping.has(key)) line[key] = retype(line[key]);
      line.expressID = -1; api.WriteLine(id, line); return line.expressID;
    };
    const remap = (value: any): any => Array.isArray(value) ? value.map(remap)
      : value && value.type === 5 && Number.isInteger(value.value) ? new Handle(clone(value.value)) : value;
    const label = (text: string) => api.CreateIfcType(id, IFCLABEL, text);
    const guidValue = (text: string) => api.CreateIfcType(id, IFCGLOBALLYUNIQUEID, text);
    function clone(oldId: number): number {
      const known = memo.get(oldId); if (known !== undefined) return known;
      const line = api.GetLine(id, oldId) as Line;
      if (sharedGeometryTypes.has(line.type)) return oldId;
      const copy: any = { ...line };
      for (const key of Object.keys(copy)) if (!bookkeeping.has(key)) copy[key] = remap(copy[key]);
      const created = write(copy); memo.set(oldId, created);
      for (const referrer of inverse.get(oldId) ?? []) {
        const other = api.GetLine(id, referrer) as Line;
        if (other.type === IFCSTYLEDITEM && other.Item?.value === oldId) write({ ...other, Item: new Handle(created) });
        else if (other.type === IFCPRESENTATIONLAYERASSIGNMENT) { other.AssignedItems = [...other.AssignedItems, new Handle(created)]; api.WriteLine(id, other); }
      }
      return created;
    }
    // Element: own placement (parent chain shared) and owned geometry instances.
    const placement = api.GetLine(id, source.ObjectPlacement.value) as Line;
    const placementId = write({ ...placement, RelativePlacement: new Handle(clone(placement.RelativePlacement.value)) });
    const element: any = { ...source, ObjectPlacement: new Handle(placementId),
      Representation: source.Representation ? new Handle(clone(source.Representation.value)) : source.Representation };
    element.GlobalId = guidValue(newGuid);
    if (options.name !== undefined) element.Name = label(options.name);
    const copyId = write(element);
    // Relations naming the source.
    for (const relId of inverse.get(source.expressID) ?? []) {
      if (!relationships.has(relId)) continue;
      const rel = api.GetLine(id, relId) as Line;
      const append = (field: "RelatedElements" | "RelatedObjects") => { rel[field] = [...rel[field], new Handle(copyId)]; api.WriteLine(id, rel); };
      if (rel.type === IFCRELCONTAINEDINSPATIALSTRUCTURE) append("RelatedElements");
      else if (rel.type === IFCRELDEFINESBYTYPE) append("RelatedObjects");
      else if (rel.type === IFCRELDEFINESBYPROPERTIES) {
        if (rel.RelatedObjects.length === 1) {
          const pset: any = { ...(api.GetLine(id, rel.RelatingPropertyDefinition.value) as Line) };
          if (pset.HasProperties) pset.HasProperties = remap(pset.HasProperties);
          if (pset.GlobalId) pset.GlobalId = guidValue(derived("pset:" + relId));
          const psetId = write(pset);
          write({ ...rel, GlobalId: guidValue(derived("rel:" + relId)),
            RelatedObjects: [new Handle(copyId)], RelatingPropertyDefinition: new Handle(psetId) });
        } else append("RelatedObjects");
      } else if (associates.has(relId)) append("RelatedObjects");
    }
    if (offset.some(v => v !== 0)) {
      const copy = api.GetLine(id, copyId) as Line;
      const pose = chain(api, id, copy.ObjectPlacement).pose;
      applyPose(api, id, copy, { position: [pose.position[0] + offset[0], pose.position[1] + offset[1], pose.position[2] + offset[2]], yawRadians: pose.yawRadians });
    }
    return api.SaveModel(id);
  });
}

/**
 * Removes one furniture/fixture/proxy element and the data it owns: containment, type,
 * material/associate and property-set memberships, its placement and geometry instances
 * (shared IfcRepresentationMap sources, types and materials survive).
 * Refuses with `unsupported-relation` when any other relation or entity references the element.
 */
export function removeFurniture(api: IfcAPI, bytes: Uint8Array, guid: string): Uint8Array {
  return lifecycleModel(api, bytes, (id, api) => {
    const source = lifecycleFind(api, id, guid);
    const inverse = inverseReferences(api, id);
    const relationships = typeSet(api, id, IFCRELATIONSHIP);
    const associates = typeSet(api, id, IFCRELASSOCIATES);
    const plan: { rel: Line; field: "RelatedElements" | "RelatedObjects" }[] = [];
    for (const referrer of inverse.get(source.expressID) ?? []) {
      const rel = api.GetLine(id, referrer) as Line;
      const field = rel.type === IFCRELCONTAINEDINSPATIALSTRUCTURE ? "RelatedElements"
        : rel.type === IFCRELDEFINESBYTYPE || rel.type === IFCRELDEFINESBYPROPERTIES || associates.has(referrer) ? "RelatedObjects" : null;
      if (!relationships.has(referrer) || field === null) throw new FurnitureLifecycleError("unsupported-relation",
        `The element is referenced by ${api.GetNameFromTypeCode(rel.type).replace(/^IFC/, "Ifc")}, which cannot be safely cleaned. Remove that relation in the IFC authoring tool first.`);
      plan.push({ rel, field });
    }
    const deleted = new Set<number>();
    const presentation = (referrer: number, target: number) => {
      const other = api.GetLine(id, referrer) as Line;
      return (other.type === IFCSTYLEDITEM && other.Item?.value === target) || other.type === IFCPRESENTATIONLAYERASSIGNMENT;
    };
    function release(target: number): void {
      if (deleted.has(target)) return;
      const line = api.GetLine(id, target) as Line;
      if (sharedGeometryTypes.has(line.type)) return;
      if ([...(inverse.get(target) ?? [])].some(r => !deleted.has(r) && !presentation(r, target))) return;
      deleted.add(target);
      for (const referrer of inverse.get(target) ?? []) {
        if (deleted.has(referrer)) continue;
        const other = api.GetLine(id, referrer) as Line;
        if (other.type === IFCSTYLEDITEM) { deleted.add(referrer); api.DeleteLine(id, referrer); }
        else if (other.type === IFCPRESENTATIONLAYERASSIGNMENT) {
          other.AssignedItems = other.AssignedItems.filter((item: any) => item.value !== target); api.WriteLine(id, other);
        }
      }
      api.DeleteLine(id, target);
      for (const child of lineRefs(line)) release(child);
    }
    for (const { rel, field } of plan) {
      const remaining = rel[field].filter((item: any) => item.value !== source.expressID);
      if (remaining.length > 0) { rel[field] = remaining; api.WriteLine(id, rel); continue; }
      deleted.add(rel.expressID); api.DeleteLine(id, rel.expressID);
      // Only owned property definitions go with an emptied relation; types, materials and structures are shared entities.
      if (rel.type === IFCRELDEFINESBYPROPERTIES) release(rel.RelatingPropertyDefinition.value);
    }
    deleted.add(source.expressID);
    api.DeleteLine(id, source.expressID);
    for (const child of lineRefs(source)) release(child);
    return api.SaveModel(id);
  });
}
