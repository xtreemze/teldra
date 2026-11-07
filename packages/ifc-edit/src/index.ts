import { IfcAPI, IFCFURNITURE, IFCLIGHTFIXTURE, IFCBUILDINGELEMENTPROXY, IFCPROJECT, IFCSIUNIT, IFCLOCALPLACEMENT, IFCAXIS2PLACEMENT3D, IFCCARTESIANPOINT, IFCDIRECTION, IFCLENGTHMEASURE, IFCREAL, IFCLABEL, IFCPRODUCTDEFINITIONSHAPE, IFCSHAPEREPRESENTATION, IFCREPRESENTATIONMAP, IFCMAPPEDITEM, IFCCARTESIANTRANSFORMATIONOPERATOR3D } from "web-ifc";

/** IFC world coordinates in metres, Z up; rotation is about world Z. */
export interface FurniturePose { readonly position: readonly [number, number, number]; readonly yawRadians: number; readonly uniformScale?: number }
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
    for (let i = 0; i < ids.size(); i++) { const line = api.GetLine(modelID, ids.get(i)) as Line; if (line.GlobalId?.value === guid) found.push(line); }
  }
  if (found.length !== 1) throw new Error("Expected exactly one supported IFC element GlobalId.");
  const furniture = found[0]!;
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
const scaleMarker = "Teldra uniform scale v1";
function scaleInfo(api: IfcAPI, id: number, furniture: Line): { scale: number; shapes: any[] | null } {
  if (!furniture.Representation) return { scale: 1, shapes: null };
  const product = api.GetLine(id, furniture.Representation.value) as Line;
  if (product?.type !== IFCPRODUCTDEFINITIONSHAPE || !Array.isArray(product.Representations) || !product.Representations.length) throw new Error("Unsupported furniture representation.");
  if (product.Name?.value !== scaleMarker) return { scale: 1, shapes: product.Representations };
  let scale: number | undefined;
  const shapes = product.Representations.map((ref: any) => {
    const shape = api.GetLine(id, ref.value) as Line;
    if (shape?.type !== IFCSHAPEREPRESENTATION || shape.RepresentationType?.value !== "MappedRepresentation" || shape.Items?.length !== 1) throw new Error("Invalid scaled furniture representation.");
    const item = api.GetLine(id, shape.Items[0].value) as Line;
    const map = item && api.GetLine(id, item.MappingSource?.value) as Line;
    const target = item && api.GetLine(id, item.MappingTarget?.value) as Line;
    if (item?.type !== IFCMAPPEDITEM || map?.type !== IFCREPRESENTATIONMAP || target?.type !== IFCCARTESIANTRANSFORMATIONOPERATOR3D || target.Axis1 || target.Axis2 || target.Axis3) throw new Error("Invalid scaled furniture mapping.");
    const origin = api.GetLine(id, target.LocalOrigin?.value) as Line;
    const mappingOrigin = api.GetLine(id, map.MappingOrigin?.value) as Line;
    const mapPoint = mappingOrigin && api.GetLine(id, mappingOrigin.Location?.value) as Line;
    if (origin?.type !== IFCCARTESIANPOINT || numeric(origin.Coordinates, "Mapping origin").some(v => v !== 0) || mappingOrigin?.type !== IFCAXIS2PLACEMENT3D || mappingOrigin.Axis || mappingOrigin.RefDirection || mapPoint?.type !== IFCCARTESIANPOINT || numeric(mapPoint.Coordinates, "Mapping origin").some(v => v !== 0)) throw new Error("Invalid scaled furniture mapping origin.");
    const value = target.Scale?.value ?? 1;
    if (!Number.isFinite(value) || value <= 0 || (scale !== undefined && Math.abs(scale - value) > epsilon)) throw new Error("Invalid furniture scale.");
    scale = value;
    return map.MappedRepresentation;
  });
  return { scale: scale!, shapes };
}
function writeScale(api: IfcAPI, id: number, furniture: Line, scale: number): void {
  const info = scaleInfo(api, id, furniture);
  if (Math.abs(scale - info.scale) < epsilon) return;
  if (!info.shapes) throw new Error("Furniture has no IFC geometry to scale.");
  const number = (v: number) => api.CreateIfcType(id, IFCLENGTHMEASURE, v);
  const origin = api.CreateIfcEntity(id, IFCCARTESIANPOINT, [number(0), number(0), number(0)]);
  const axis = api.CreateIfcEntity(id, IFCAXIS2PLACEMENT3D, origin, null, null);
  const target = api.CreateIfcEntity(id, IFCCARTESIANTRANSFORMATIONOPERATOR3D, null, null, origin, api.CreateIfcType(id, IFCREAL, scale), null);
  const shapes = info.shapes.map((ref: any) => {
    const shape = api.GetLine(id, ref.value) as Line;
    if (shape?.type !== IFCSHAPEREPRESENTATION || !shape.ContextOfItems || !shape.Items?.length) throw new Error("Unsupported furniture shape representation.");
    const map = api.CreateIfcEntity(id, IFCREPRESENTATIONMAP, axis, ref);
    const item = api.CreateIfcEntity(id, IFCMAPPEDITEM, map, target);
    return api.CreateIfcEntity(id, IFCSHAPEREPRESENTATION, shape.ContextOfItems, shape.RepresentationIdentifier, api.CreateIfcType(id, IFCLABEL, "MappedRepresentation"), [item]);
  });
  furniture.Representation = api.CreateIfcEntity(id, IFCPRODUCTDEFINITIONSHAPE, api.CreateIfcType(id, IFCLABEL, scaleMarker), null, shapes);
}
export function readFurniturePose(api: IfcAPI, bytes: Uint8Array, guid: string): FurniturePose {
  return model(api, bytes, (id) => { const furniture = find(api, id, guid); const pose = chain(api, id, furniture.ObjectPlacement).pose; const scale = scaleInfo(api, id, furniture).scale; return scale === 1 ? pose : { ...pose, uniformScale: scale }; });
}
export function writeFurniturePose(api: IfcAPI, bytes: Uint8Array, guid: string, pose: FurniturePose): Uint8Array {
  if (pose.position.length !== 3 || ![...pose.position, pose.yawRadians, pose.uniformScale ?? 1].every(Number.isFinite) || (pose.uniformScale ?? 1) <= 0) throw new Error("Furniture pose must be finite and scale must be positive.");
  return model(api, bytes, (id) => {
    const furniture = find(api, id, guid); writeScale(api, id, furniture, pose.uniformScale ?? 1); const { parent, relativeParent } = chain(api, id, furniture.ObjectPlacement);
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
