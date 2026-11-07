import { IfcAPI, IFCFURNITURE, IFCPROJECT, IFCSIUNIT, IFCLOCALPLACEMENT, IFCAXIS2PLACEMENT3D, IFCCARTESIANPOINT, IFCDIRECTION, IFCLENGTHMEASURE, IFCREAL } from "web-ifc";

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
  const ids = api.GetLineIDsWithType(modelID, IFCFURNITURE);
  const found: Line[] = [];
  for (let i = 0; i < ids.size(); i++) { const line = api.GetLine(modelID, ids.get(i)) as Line; if (line.GlobalId?.value === guid) found.push(line); }
  if (found.length !== 1) throw new Error("Expected exactly one matching IfcFurniture GlobalId.");
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
