import { IfcAPI, IFCRELFILLSELEMENT, IFCLIGHTFIXTURE, IFCBUILDINGELEMENTPROXY, IFCFURNITURE, IFCPROJECT, IFCSIUNIT, IFCLOCALPLACEMENT, IFCAXIS2PLACEMENT3D, IFCCARTESIANPOINT, IFCDIRECTION, IFCLENGTHMEASURE, IFCREAL, IFCPRODUCT, IFCPRODUCTDEFINITIONSHAPE, IFCSHAPEREPRESENTATION, IFCMAPPEDITEM, IFCREPRESENTATIONMAP, IFCCARTESIANTRANSFORMATIONOPERATOR3D, IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM, IFCRELDEFINESBYPROPERTIES, IFCPROPERTYSET, IFCPROPERTYSINGLEVALUE, IFCTRIANGULATEDFACESET, IFCCARTESIANPOINTLIST3D } from "web-ifc";
import { chain, epsilon, model, numeric, type FurniturePose, type Line } from "./ifc-session.js";
export type { FurniturePose } from "./ifc-session.js";
export * from "./wall.js";
export * from "./furniture-insert.js";
export * from "./tessellation.js";
export * from "./plan.js";

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
  return model(api, bytes, (id) => chain(api, id, find(api, id, guid).ObjectPlacement).pose);
}
export function writeFurniturePose(api: IfcAPI, bytes: Uint8Array, guid: string, pose: FurniturePose): Uint8Array {
  if (pose.position.length !== 3 || ![...pose.position, pose.yawRadians].every(Number.isFinite)) throw new Error("Furniture pose must be finite.");
  return model(api, bytes, (id) => {
    const furniture = find(api, id, guid); const { parent, relativeParent } = chain(api, id, furniture.ObjectPlacement);
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
  return model(api, bytes, id => {
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
  return model(api, bytes, id => mappedFurniture(api, id, guid).scale);
}
/** Updates only a fresh per-instance MappingTarget, never shared map geometry or stable identity. */
export function writeFurnitureGeometryScale(api: IfcAPI, bytes: Uint8Array, guid: string,
  scale: FurnitureGeometryScale): Uint8Array {
  validGeometryScale(scale);
  return model(api, bytes, id => {
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
  return model(api, bytes, (id) => {
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
