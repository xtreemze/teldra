import { IfcAPI, IFCRELFILLSELEMENT, IFCLIGHTFIXTURE, IFCBUILDINGELEMENTPROXY, IFCFURNITURE, IFCPROJECT, IFCSIUNIT, IFCLOCALPLACEMENT, IFCAXIS2PLACEMENT3D, IFCCARTESIANPOINT, IFCDIRECTION, IFCLENGTHMEASURE, IFCREAL, IFCPRODUCT, IFCPRODUCTDEFINITIONSHAPE, IFCSHAPEREPRESENTATION, IFCMAPPEDITEM, IFCREPRESENTATIONMAP, IFCCARTESIANTRANSFORMATIONOPERATOR3D, IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM, IFCRELDEFINESBYPROPERTIES, IFCPROPERTYSET, IFCPROPERTYSINGLEVALUE } from "web-ifc";

/** IFC world coordinates in metres, Z up; rotation is about world Z. */
export interface FurniturePose { readonly position: readonly [number, number, number]; readonly yawRadians: number }
type Line = { expressID: number; type: number; [key: string]: any };
const epsilon = 1e-8;

function model<T>(api: IfcAPI, bytes: Uint8Array, run: (id: number) => T): T {
  const id = api.OpenModel(bytes);
  try {
    if (api.GetModelSchema(id) !== "IFC4") throw new Error("Only IFC4 furniture placement is supported.");
    const projects = api.GetLineIDsWithType(id, IFCPROJECT);
    if (projects.size() !== 1) throw new Error("Expected exactly one IFC project.");
    const project = api.GetLine(id, projects.get(0), true) as Line;
    const units = project.UnitsInContext?.Units;
    const lengths = Array.isArray(units) ? units.filter((unit: Line) => unit.UnitType?.value === "LENGTHUNIT") : [];
    if (lengths.length !== 1 || lengths[0].Name?.value !== "METRE" || lengths[0].Prefix !== null || lengths[0].type !== IFCSIUNIT) throw new Error("Only unprefixed metre IFC length units are supported.");
    return run(id);
  } finally { api.CloseModel(id); }
}
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
function numeric(values: any, label: string): [number, number, number] {
  if (!Array.isArray(values) || values.length !== 3) throw new Error(`${label} must have three coordinates.`);
  const result = values.map((value: any) => value.value);
  if (!result.every(Number.isFinite)) throw new Error(`${label} must be finite.`);
  return result as [number, number, number];
}
function chain(api: IfcAPI, modelID: number, handle: any): { pose: FurniturePose; parent: FurniturePose; relativeParent: any } {
  const seen = new Set<number>();
  function visit(ref: any): FurniturePose {
    if (!ref || !Number.isInteger(ref.value) || seen.has(ref.value)) throw new Error("Invalid or cyclic IFC placement hierarchy.");
    seen.add(ref.value);
    const p = api.GetLine(modelID, ref.value) as Line;
    if (p?.type !== IFCLOCALPLACEMENT) throw new Error("Only IfcLocalPlacement is supported.");
    const parent = p.PlacementRelTo ? visit(p.PlacementRelTo) : { position: [0, 0, 0] as [number, number, number], yawRadians: 0 };
    const axis = api.GetLine(modelID, p.RelativePlacement?.value) as Line;
    if (axis?.type !== IFCAXIS2PLACEMENT3D) throw new Error("Only IfcAxis2Placement3D is supported.");
    const location = api.GetLine(modelID, axis.Location?.value) as Line;
    if (location?.type !== IFCCARTESIANPOINT) throw new Error("Invalid IFC placement origin.");
    const pos = numeric(location.Coordinates, "IFC origin");
    const readDirection = (ref: any, fallback: [number, number, number]) => {
      if (!ref) return fallback;
      const line = api.GetLine(modelID, ref.value) as Line;
      if (line?.type !== IFCDIRECTION) throw new Error("Invalid IFC placement direction.");
      return numeric(line.DirectionRatios, "IFC direction");
    };
    const z = readDirection(axis.Axis, [0, 0, 1]); const x = readDirection(axis.RefDirection, [1, 0, 0]);
    if (Math.abs(z[0]) > epsilon || Math.abs(z[1]) > epsilon || z[2] <= epsilon || Math.abs(x[2]) > epsilon || Math.hypot(x[0], x[1]) < epsilon) throw new Error("Only upright IFC placement rotations are supported.");
    const c = Math.cos(parent.yawRadians), s = Math.sin(parent.yawRadians);
    return { position: [parent.position[0] + c * pos[0] - s * pos[1], parent.position[1] + s * pos[0] + c * pos[1], parent.position[2] + pos[2]], yawRadians: parent.yawRadians + Math.atan2(x[1], x[0]) };
  }
  const root = api.GetLine(modelID, handle?.value) as Line;
  if (root?.type !== IFCLOCALPLACEMENT) throw new Error("Furniture has no supported local placement.");
  const parent = root.PlacementRelTo ? visit(root.PlacementRelTo) : { position: [0, 0, 0] as [number, number, number], yawRadians: 0 };
  seen.clear();
  const pose = visit(handle);
  return { pose, parent, relativeParent: root.PlacementRelTo };
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
