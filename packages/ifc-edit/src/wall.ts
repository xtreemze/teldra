import {
  Handle, IFC4, IfcAPI,
  IFCARBITRARYCLOSEDPROFILEDEF, IFCAXIS2PLACEMENT3D, IFCBUILDINGSTOREY, IFCCARTESIANPOINT, IFCCARTESIANPOINTLIST2D,
  IFCDIRECTION, IFCEXTRUDEDAREASOLID, IFCGEOMETRICREPRESENTATIONSUBCONTEXT, IFCGLOBALLYUNIQUEID, IFCINDEXEDPOLYCURVE,
  IFCLABEL, IFCLENGTHMEASURE, IFCLOCALPLACEMENT, IFCMATERIAL, IFCMATERIALLAYER, IFCMATERIALLAYERSET, IFCMATERIALLAYERSETUSAGE,
  IFCNONNEGATIVELENGTHMEASURE, IFCPOLYLINE, IFCPOSITIVELENGTHMEASURE, IFCPRODUCTDEFINITIONSHAPE, IFCREAL,
  IFCRELASSOCIATESMATERIAL, IFCRELCONNECTSPATHELEMENTS, IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELDEFINESBYPROPERTIES,
  IFCRELVOIDSELEMENT, IFCSHAPEREPRESENTATION, IFCWALL, IFCWALLSTANDARDCASE,
} from "web-ifc";
import { chain, model, type Line } from "./ifc-session.js";

/**
 * Straight, rectangular IfcWall editing on IFC4 metre models.
 *
 * Wall axis convention (matches Teldra's importer and IfcOpenShell `create_2pt_wall`):
 * the local X axis of the wall placement is the axis line from `start` to `end`;
 * the Body is a rectangle spanning local X 0..length and local Y 0..thickness,
 * extruded along +Z by `height`. All public coordinates are world IFC metres, Z up.
 *
 * Walls may additionally carry an `Axis` (Plan/Curve2D) reference line and a single-layer
 * `IfcMaterialLayerSetUsage` (what Teldra's SH3D importer and `teldra_ifc.bim` emit). The Axis is
 * always the local segment (0,0)->(length,0); on update it is rewritten with the Body, and a
 * thickness change updates the single layer (in place when solely owned, otherwise a fresh
 * single-layer set reusing the same material is assigned to this wall's usage). Shared usages and
 * multi-layer sets are refused with `shared-material` / `unsupported-material`.
 *
 * Every function is pure with respect to its input bytes: a staged copy is opened,
 * edited and serialised, so a thrown error never mutates the caller's model.
 * Existing IFC GlobalIds are never rewritten.
 */
export type WallEditErrorCode =
  | "invalid-geometry" | "invalid-global-id" | "invalid-name" | "duplicate-global-id"
  | "wall-not-found" | "storey-not-found" | "storey-containment-unsupported" | "body-context-missing"
  | "hosted-opening" | "wall-referenced" | "unsupported-relationship" | "unsupported-connection"
  | "unsupported-representation" | "unsupported-placement" | "shared-geometry"
  | "shared-material" | "unsupported-material";

export class WallEditError extends Error {
  readonly code: WallEditErrorCode;
  constructor(code: WallEditErrorCode, message: string) { super(message); this.name = "WallEditError"; this.code = code; }
}
const fail = (code: WallEditErrorCode, message: string): never => { throw new WallEditError(code, message); };

export type WallEnd = "start" | "end";
export interface WallGeometry {
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
  readonly thickness: number;
  readonly height: number;
  /** World Z of the wall base. */
  readonly elevation: number;
}
export interface WallConnection { readonly wallGlobalId: string; readonly end: WallEnd; readonly otherEnd: WallEnd }
export interface WallRecord extends WallGeometry { readonly connections: readonly WallConnection[] }
export interface WallChange {
  readonly globalId: string;
  readonly kind: "created" | "updated" | "removed";
  /** `requested` for the addressed wall, `connected` for neighbours kept joined. */
  readonly cause: "requested" | "connected";
  readonly before: WallGeometry | null;
  readonly after: WallGeometry | null;
}
export interface CreateWallInput {
  readonly globalId: string;
  readonly storeyGlobalId: string;
  readonly name: string;
  readonly geometry: WallGeometry;
}

export const WALL_LIMITS = Object.freeze({ minLength: 1e-3, maxLength: 10_000, maxThickness: 100, maxHeight: 100, maxElevation: 10_000 });
const COINCIDENT = 1e-9;
const GUID = /^[0-3][0-9A-Za-z_$]{21}$/;

export function validateWallGeometry(geometry: WallGeometry, label = "Wall"): void {
  const { start, end } = geometry;
  if (!Array.isArray(start) || !Array.isArray(end) || start.length !== 2 || end.length !== 2)
    fail("invalid-geometry", `${label} endpoints must be 2D metre coordinates.`);
  const all = [...start, ...end, geometry.thickness, geometry.height, geometry.elevation];
  if (!all.every(Number.isFinite)) fail("invalid-geometry", `${label} coordinates and dimensions must be finite.`);
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (length < WALL_LIMITS.minLength || length > WALL_LIMITS.maxLength)
    fail("invalid-geometry", `${label} length ${length} m is outside ${WALL_LIMITS.minLength}..${WALL_LIMITS.maxLength} m.`);
  if (!(geometry.thickness > 0 && geometry.thickness <= WALL_LIMITS.maxThickness))
    fail("invalid-geometry", `${label} thickness must be positive and at most ${WALL_LIMITS.maxThickness} m.`);
  if (!(geometry.height > 0 && geometry.height <= WALL_LIMITS.maxHeight))
    fail("invalid-geometry", `${label} height must be positive and at most ${WALL_LIMITS.maxHeight} m.`);
  if (Math.abs(geometry.elevation) > WALL_LIMITS.maxElevation)
    fail("invalid-geometry", `${label} elevation is outside supported bounds.`);
}

// ---------------------------------------------------------------- graph helpers

const isRef = (v: any): v is { type: 5; value: number } => v != null && typeof v === "object" && v.type === 5 && Number.isInteger(v.value);
const refId = (v: any): number | null => (isRef(v) ? v.value : null);
const clean = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
const near = (a: readonly number[], b: readonly number[], tol = COINCIDENT) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) <= tol);

function forEachRef(value: any, visit: (id: number, field: string) => void, field = ""): void {
  if (Array.isArray(value)) { for (const item of value) forEachRef(item, visit, field); return; }
  if (isRef(value)) { visit(value.value, field); return; }
}

interface Graph {
  readonly api: IfcAPI;
  readonly id: number;
  line(expressID: number): Line;
  /** express IDs of lines referencing the target. */
  referrers(target: number): number[];
  type(expressID: number): number;
  wallsByGuid(): Map<string, number>;
  allGlobalIds(): Set<string>;
}
function graph(api: IfcAPI, id: number): Graph {
  const cache = new Map<number, Line>();
  const line = (e: number): Line => {
    let found = cache.get(e);
    if (!found) { found = api.GetLine(id, e) as Line; cache.set(e, found); }
    return found;
  };
  let incoming: Map<number, number[]> | null = null;
  const build = () => {
    const map = new Map<number, number[]>();
    const all = api.GetAllLines(id);
    for (let i = 0; i < all.size(); i++) {
      const e = all.get(i);
      let l: Line;
      try { l = api.GetLine(id, e) as Line; } catch { continue; }
      for (const [field, value] of Object.entries(l)) {
        if (field === "expressID" || field === "type") continue;
        forEachRef(value, (target) => { const list = map.get(target); if (list) list.push(e); else map.set(target, [e]); }, field);
      }
    }
    return map;
  };
  return {
    api, id, line,
    referrers: (target) => { incoming ??= build(); return [...new Set(incoming.get(target) ?? [])]; },
    type: (e) => api.GetLineType(id, e) as number,
    wallsByGuid: () => {
      const out = new Map<string, number>();
      for (const type of [IFCWALL, IFCWALLSTANDARDCASE]) {
        const ids = api.GetLineIDsWithType(id, type);
        for (let i = 0; i < ids.size(); i++) out.set(line(ids.get(i)).GlobalId?.value, ids.get(i));
      }
      return out;
    },
    allGlobalIds: () => {
      const out = new Set<string>();
      const all = api.GetAllLines(id);
      for (let i = 0; i < all.size(); i++) {
        try { const g = (api.GetLine(id, all.get(i)) as Line).GlobalId?.value; if (typeof g === "string") out.add(g); } catch { /* non-rooted */ }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- wall parsing

type AxisParts =
  | { readonly kind: "indexed"; readonly listId: number }
  | { readonly kind: "polyline"; readonly pointIds: readonly [number, number] };
interface WallParts {
  readonly guid: string;
  readonly wall: Line;
  readonly placementId: number;
  readonly pointId: number;
  readonly axisId: number;
  readonly refDirectionId: number | null;
  readonly listId: number;
  readonly solidId: number;
  readonly axis: AxisParts | null;
  readonly owned: readonly number[];
  readonly parent: { position: readonly [number, number, number]; yawRadians: number };
  readonly geometry: WallGeometry;
}
const handleOf = (ref: any, label: string, code: WallEditErrorCode = "unsupported-representation"): number => {
  const id = refId(ref);
  if (id === null) fail(code, `Missing ${label}.`);
  return id as number;
};
const ratios = (g: Graph, ref: any, label: string): number[] => {
  const l = g.line(handleOf(ref, label));
  if (g.type(l.expressID) !== IFCDIRECTION) fail("unsupported-representation", `${label} must be an IfcDirection.`);
  return l.DirectionRatios.map((v: any) => v.value);
};

/** Axis = a 2-point 2D reference line: IfcIndexedPolyCurve over a 2D point list, or an IfcPolyline. */
function parseAxis(g: Graph, guid: string, rep: Line): AxisParts {
  if (rep.RepresentationType?.value !== "Curve2D" || rep.Items?.length !== 1)
    return fail("unsupported-representation", `Wall ${guid} Axis must be a single Curve2D item.`);
  const curveId = handleOf(rep.Items[0], "wall axis curve");
  const curve = g.line(curveId);
  const t = g.type(curveId);
  if (t === IFCINDEXEDPOLYCURVE && !curve.Segments) {
    const listId = handleOf(curve.Points, "wall axis points");
    if (g.type(listId) === IFCCARTESIANPOINTLIST2D && g.line(listId).CoordList?.length === 2) return { kind: "indexed", listId };
  } else if (t === IFCPOLYLINE && Array.isArray(curve.Points) && curve.Points.length === 2) {
    const ids = curve.Points.map((p: any) => handleOf(p, "wall axis point"));
    if (ids.every((i: number) => g.type(i) === IFCCARTESIANPOINT && g.line(i).Coordinates?.length === 2)) return { kind: "polyline", pointIds: [ids[0] as number, ids[1] as number] };
  }
  return fail("unsupported-representation", `Wall ${guid} Axis must be a straight two-point 2D line.`);
}

function parseWall(g: Graph, guid: string): WallParts {
  const wallId = g.wallsByGuid().get(guid);
  if (wallId === undefined) return fail("wall-not-found", `No IfcWall has GlobalId ${guid}.`);
  const wall = g.line(wallId);
  let pose, parent;
  try { ({ pose, parent } = chain(g.api, g.id, wall.ObjectPlacement)); }
  catch (e) { return fail("unsupported-placement", `Wall ${guid}: ${(e as Error).message}`); }
  const placementId = handleOf(wall.ObjectPlacement, "wall placement", "unsupported-placement");
  const placement = g.line(placementId);
  const axisId = handleOf(placement.RelativePlacement, "wall relative placement", "unsupported-placement");
  const axis = g.line(axisId);
  const pointId = handleOf(axis.Location, "wall placement origin", "unsupported-placement");
  const refDirectionId = refId(axis.RefDirection);

  const pdsId = handleOf(wall.Representation, "wall representation");
  const pds = g.line(pdsId);
  if (g.type(pdsId) !== IFCPRODUCTDEFINITIONSHAPE || !Array.isArray(pds.Representations))
    return fail("unsupported-representation", `Wall ${guid} has no product definition shape.`);
  const reps = (pds.Representations as any[]).map((r) => g.line(handleOf(r, "wall shape representation")));
  const identifier = (r: Line) => (g.type(r.expressID) === IFCSHAPEREPRESENTATION ? r.RepresentationIdentifier?.value : undefined);
  const bodies = reps.filter((r) => identifier(r) === "Body"), axes = reps.filter((r) => identifier(r) === "Axis");
  if (bodies.length !== 1 || axes.length > 1 || bodies.length + axes.length !== reps.length)
    fail("unsupported-representation", `Wall ${guid} needs exactly one Body representation (plus at most one Axis).`);
  const rep = bodies[0]!;
  if (rep.RepresentationType?.value !== "SweptSolid" || rep.Items?.length !== 1)
    fail("unsupported-representation", `Wall ${guid} needs one Body/SweptSolid extrusion.`);
  const axis2d = axes[0] ? parseAxis(g, guid, axes[0]) : null;
  const solidId = handleOf(rep.Items[0], "wall extrusion");
  const solid = g.line(solidId);
  if (g.type(solidId) !== IFCEXTRUDEDAREASOLID) fail("unsupported-representation", `Wall ${guid} Body is not an IfcExtrudedAreaSolid.`);
  if (!near(ratios(g, solid.ExtrudedDirection, "extrusion direction"), [0, 0, 1]))
    fail("unsupported-representation", `Wall ${guid} must extrude along local +Z.`);
  const position = g.line(handleOf(solid.Position, "extrusion position"));
  const originOk = near(g.line(handleOf(position.Location, "extrusion origin")).Coordinates.map((v: any) => v.value), [0, 0, 0]);
  const zOk = !position.Axis || near(ratios(g, position.Axis, "extrusion Z"), [0, 0, 1]);
  const xOk = !position.RefDirection || near(ratios(g, position.RefDirection, "extrusion X"), [1, 0, 0]);
  if (!originOk || !zOk || !xOk) fail("unsupported-representation", `Wall ${guid} extrusion position must be the identity.`);

  const profileId = handleOf(solid.SweptArea, "wall profile");
  if (g.type(profileId) !== IFCARBITRARYCLOSEDPROFILEDEF) fail("unsupported-representation", `Wall ${guid} needs an arbitrary closed rectangular profile.`);
  const curveId = handleOf(g.line(profileId).OuterCurve, "wall outer curve");
  const curve = g.line(curveId);
  if (g.type(curveId) !== IFCINDEXEDPOLYCURVE || curve.Segments) fail("unsupported-representation", `Wall ${guid} outer curve must be a plain IfcIndexedPolyCurve.`);
  const listId = handleOf(curve.Points, "wall profile points");
  if (g.type(listId) !== IFCCARTESIANPOINTLIST2D) fail("unsupported-representation", `Wall ${guid} profile points must be an IfcCartesianPointList2D.`);
  const pts: number[][] = (g.line(listId).CoordList ?? []).map((p: any[]) => p.map((v) => v.value));
  const length = pts[3]?.[0] ?? NaN, thickness = pts[1]?.[1] ?? NaN;
  const rectangle = pts.length === 5 && Number.isFinite(length) && Number.isFinite(thickness) && length > 0 && thickness > 0 &&
    near(pts[0]!, [0, 0]) && near(pts[1]!, [0, thickness]) && near(pts[2]!, [length, thickness]) && near(pts[3]!, [length, 0]) && near(pts[4]!, [0, 0]);
  if (!rectangle) fail("unsupported-representation", `Wall ${guid} profile must be the rectangle (0,0)-(L,t) used by Teldra walls.`);
  const height = solid.Depth?.value;
  if (!Number.isFinite(height) || height <= 0) fail("unsupported-representation", `Wall ${guid} has no positive extrusion depth.`);

  const c = Math.cos(pose.yawRadians), s = Math.sin(pose.yawRadians);
  const start: [number, number] = [pose.position[0], pose.position[1]];
  const geometry: WallGeometry = {
    start, end: [start[0] + length * c, start[1] + length * s], thickness, height, elevation: pose.position[2],
  };
  const owned = [...closure(g, wallId, new Set(["PlacementRelTo", "ContextOfItems", "OwnerHistory"]))];
  return { guid, wall, placementId, pointId, axisId, refDirectionId, listId, solidId, axis: axis2d, owned, parent, geometry };
}

/** Entities solely reachable from a root through forward references, excluding named fields. */
function closure(g: Graph, root: number, skipFields: ReadonlySet<string>): Set<number> {
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    const l = g.line(queue.pop()!);
    for (const [field, value] of Object.entries(l)) {
      if (field === "expressID" || field === "type" || skipFields.has(field)) continue;
      forEachRef(value, (target) => { if (!seen.has(target)) { seen.add(target); queue.push(target); } });
    }
  }
  return seen;
}

const BENIGN = new Set<number>([IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELDEFINESBYPROPERTIES, IFCRELASSOCIATESMATERIAL, IFCRELCONNECTSPATHELEMENTS]);

/** Fails closed unless nothing but the wall owns its placement/geometry and no unsupported relation exists. */
function assertEditable(g: Graph, parts: WallParts): void {
  const wallId = parts.wall.expressID;
  for (const r of g.referrers(wallId)) {
    const t = g.type(r);
    if (t === IFCRELVOIDSELEMENT) fail("hosted-opening", `Wall ${parts.guid} hosts an opening; openings are not re-hosted yet.`);
    if (!BENIGN.has(t)) fail("unsupported-relationship", `Wall ${parts.guid} participates in an unsupported IFC relationship (type ${t}).`);
  }
  const owned = new Set(parts.owned);
  for (const e of parts.owned) {
    if (e === wallId) continue;
    if (g.referrers(e).some((r) => !owned.has(r)))
      fail("shared-geometry", `Wall ${parts.guid} placement or representation entity #${e} is shared with another IFC entity.`);
  }
  // Another placement relative to this wall (e.g. an opening) would silently move with it.
  if (g.referrers(parts.placementId).some((r) => r !== wallId)) fail("shared-geometry", `Wall ${parts.guid} placement has dependants.`);
}

// ---------------------------------------------------------------- connectivity

interface Edge { readonly relationId: number; readonly other: number; readonly end: WallEnd; readonly otherEnd: WallEnd; readonly supported: boolean }
const endOf = (type: unknown): WallEnd | null => (type === "ATSTART" ? "start" : type === "ATEND" ? "end" : null);

function topology(g: Graph): Map<number, Edge[]> {
  const out = new Map<number, Edge[]>();
  const ids = g.api.GetLineIDsWithType(g.id, IFCRELCONNECTSPATHELEMENTS);
  const add = (wall: number, edge: Edge) => { const list = out.get(wall); if (list) list.push(edge); else out.set(wall, [edge]); };
  for (let i = 0; i < ids.size(); i++) {
    const rel = g.line(ids.get(i));
    const a = refId(rel.RelatingElement), b = refId(rel.RelatedElement);
    if (a === null || b === null) continue;
    const ea = endOf(rel.RelatingConnectionType?.value), eb = endOf(rel.RelatedConnectionType?.value);
    const supported = ea !== null && eb !== null && a !== b;
    add(a, { relationId: rel.expressID, other: b, end: ea ?? "start", otherEnd: eb ?? "start", supported });
    add(b, { relationId: rel.expressID, other: a, end: eb ?? "start", otherEnd: ea ?? "start", supported });
  }
  return out;
}
const guidOf = (g: Graph, id: number): string => g.line(id).GlobalId?.value;

// ---------------------------------------------------------------- read

export function readWall(api: IfcAPI, bytes: Uint8Array, globalId: string): WallRecord {
  return model(api, bytes, (id) => {
    const g = graph(api, id);
    const parts = parseWall(g, globalId);
    const edges = topology(g).get(parts.wall.expressID) ?? [];
    const connections = edges.filter((e) => e.supported).map((e) => ({ wallGlobalId: guidOf(g, e.other), end: e.end, otherEnd: e.otherEnd }));
    return { ...parts.geometry, connections };
  });
}

// ---------------------------------------------------------------- material layers

/** What a thickness change must do to the wall's single-layer material usage. */
type MaterialPlan =
  | { readonly kind: "none" }
  | { readonly kind: "in-place"; readonly layerId: number; readonly layerSetId: number }
  | { readonly kind: "clone"; readonly usageId: number; readonly layerId: number; readonly layerSetId: number };

const THICKNESS_TOL = 1e-9;
const AUTO_SET_NAME = /^Wall [0-9.]+ mm$/;
const layerSetName = (thickness: number): string => `Wall ${+(thickness * 1000).toPrecision(9)} mm`;

function planMaterial(g: Graph, parts: WallParts, thickness: number): MaterialPlan {
  const wallId = parts.wall.expressID;
  const rels = g.referrers(wallId).filter((r) => g.type(r) === IFCRELASSOCIATESMATERIAL);
  if (rels.length === 0) return { kind: "none" };
  if (rels.length > 1) return fail("unsupported-material", `Wall ${parts.guid} has several material associations.`);
  const rel = g.line(rels[0]!);
  const materialId = refId(rel.RelatingMaterial);
  if (materialId === null) return { kind: "none" };
  if (g.type(materialId) === IFCMATERIAL) return { kind: "none" };
  if (g.type(materialId) !== IFCMATERIALLAYERSETUSAGE)
    return fail("unsupported-material", `Wall ${parts.guid} material is not an IfcMaterialLayerSetUsage.`);
  const usageId = materialId;
  if ((rel.RelatedObjects as any[]).length !== 1 || g.referrers(usageId).some((r) => r !== rel.expressID))
    return fail("shared-material", `Wall ${parts.guid} material layer set usage is shared with other elements.`);
  const setId = handleOf(g.line(usageId).ForLayerSet, "layer set", "unsupported-material");
  const set = g.line(setId);
  if (g.type(setId) !== IFCMATERIALLAYERSET || (set.MaterialLayers as any[])?.length !== 1)
    return fail("unsupported-material", `Wall ${parts.guid} thickness can only follow a single-layer material layer set.`);
  const layerId = handleOf(set.MaterialLayers[0], "material layer", "unsupported-material");
  if (Math.abs(g.line(layerId).LayerThickness?.value - thickness) <= THICKNESS_TOL) return { kind: "none" };
  const soleSet = g.referrers(setId).every((r) => r === usageId) && g.referrers(layerId).every((r) => r === setId);
  return soleSet ? { kind: "in-place", layerId, layerSetId: setId } : { kind: "clone", usageId, layerId, layerSetId: setId };
}

/** An existing single-layer set of `material` with this thickness, else a new one (name per Teldra convention). */
function acquireLayerSet(g: Graph, thickness: number, materialId: number | null): number {
  const { api, id } = g;
  let material = materialId;
  if (material === null) {
    const mats = api.GetLineIDsWithType(id, IFCMATERIAL);
    for (let i = 0; i < mats.size() && material === null; i++) if (g.line(mats.get(i)).Name?.value === "Wall") material = mats.get(i);
    if (material === null) {
      const created = api.CreateIfcEntity(id, IFCMATERIAL, api.CreateIfcType(id, IFCLABEL, "Wall"), null, null);
      api.WriteLine(id, created);
      material = created.expressID as number;
    }
  }
  const sets = api.GetLineIDsWithType(id, IFCMATERIALLAYERSET);
  for (let i = 0; i < sets.size(); i++) {
    const layers = g.line(sets.get(i)).MaterialLayers as any[];
    if (layers?.length !== 1) continue;
    const layer = g.line(refId(layers[0])!);
    if (refId(layer.Material) === material && Math.abs(layer.LayerThickness?.value - thickness) <= THICKNESS_TOL) return sets.get(i);
  }
  const layer = api.CreateIfcEntity(id, IFCMATERIALLAYER, new Handle(material), api.CreateIfcType(id, IFCNONNEGATIVELENGTHMEASURE, thickness), null, null, null, null, null);
  api.WriteLine(id, layer);
  const set = api.CreateIfcEntity(id, IFCMATERIALLAYERSET, [new Handle(layer.expressID)], api.CreateIfcType(id, IFCLABEL, layerSetName(thickness)), null);
  api.WriteLine(id, set);
  return set.expressID as number;
}

function applyMaterial(g: Graph, plan: MaterialPlan, thickness: number): void {
  const { api, id } = g;
  if (plan.kind === "in-place") {
    const layer = g.line(plan.layerId);
    layer.LayerThickness = api.CreateIfcType(id, IFCNONNEGATIVELENGTHMEASURE, thickness);
    api.WriteLine(id, layer);
    const set = g.line(plan.layerSetId);
    if (typeof set.LayerSetName?.value === "string" && AUTO_SET_NAME.test(set.LayerSetName.value)) {
      set.LayerSetName = api.CreateIfcType(id, IFCLABEL, layerSetName(thickness));
      api.WriteLine(id, set);
    }
  } else if (plan.kind === "clone") {
    const usage = g.line(plan.usageId);
    usage.ForLayerSet = new Handle(acquireLayerSet(g, thickness, refId(g.line(plan.layerId).Material)));
    api.WriteLine(id, usage);
  }
}

/** Deterministic, unique compressed IFC GlobalId derived from a seed (relationship ids of created walls). */
function derivedGuid(seed: string, taken: ReadonlySet<string>): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  for (let salt = 0; ; salt++) {
    const bytes: number[] = [];
    const h = [0x811c9dc5, 0x01000193, 0xdeadbeef, 0x9e3779b9];
    for (const ch of `${seed}#${salt}`) for (let k = 0; k < 4; k++) { h[k] = Math.imul(h[k]! ^ ch.charCodeAt(0), 0x01000193 + 2 * k) >>> 0; h[(k + 1) % 4] = (h[(k + 1) % 4]! + (h[k]! >>> 13)) >>> 0; }
    for (const w of h) bytes.push(w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255);
    let big = 0n;
    for (const b of bytes) big = (big << 8n) | BigInt(b);
    let out = "";
    for (let i = 0; i < 22; i++) { out = alphabet[Number(big & (i === 21 ? 3n : 63n))]! + out; big >>= i === 21 ? 2n : 6n; }
    if (!taken.has(out)) return out;
  }
}

// ---------------------------------------------------------------- update

interface Write { readonly parts: WallParts; readonly after: WallGeometry; readonly material: MaterialPlan }
function planUpdate(g: Graph, guid: string, target: WallGeometry): { changes: WallChange[]; writes: Write[] } {
  validateWallGeometry(target, `Wall ${guid}`);
  const parts = parseWall(g, guid);
  assertEditable(g, parts);
  const before = parts.geometry;
  const moved: Record<WallEnd, boolean> = { start: !near(before.start, target.start), end: !near(before.end, target.end) };
  const dimsChanged = !near([before.thickness, before.height, before.elevation], [target.thickness, target.height, target.elevation]);
  if (!moved.start && !moved.end && !dimsChanged) return { changes: [], writes: [] };

  const topo = topology(g);
  const edges = topo.get(parts.wall.expressID) ?? [];
  const axisMoves = moved.start || moved.end;
  if (axisMoves && edges.some((e) => !e.supported))
    fail("unsupported-connection", `Wall ${guid} has a path/T-junction or undefined connection; moving its axis needs topology recomputation.`);

  const overrides = new Map<number, Partial<Record<WallEnd, readonly [number, number]>>>();
  const queue: Array<{ wall: number; end: WallEnd; point: readonly [number, number] }> = [];
  const originId = parts.wall.expressID;
  for (const end of ["start", "end"] as const) if (moved[end]) queue.push({ wall: originId, end, point: target[end] });
  const visited = new Set<string>(queue.map((q) => `${q.wall}:${q.end}`));
  const order: number[] = [];
  while (queue.length) {
    const node = queue.shift()!;
    for (const edge of topo.get(node.wall) ?? []) {
      if (edge.end !== node.end) continue;
      if (!edge.supported) fail("unsupported-connection", `Wall ${guidOf(g, node.wall)} has an unsupported connection at its ${node.end}.`);
      const key = `${edge.other}:${edge.otherEnd}`;
      if (visited.has(key)) continue;
      if (edge.other === originId) fail("unsupported-connection", `Wall ${guid} is connected back to itself through other walls.`);
      visited.add(key);
      const entry = overrides.get(edge.other) ?? {};
      if (!overrides.has(edge.other)) order.push(edge.other);
      entry[edge.otherEnd] = node.point;
      overrides.set(edge.other, entry);
      queue.push({ wall: edge.other, end: edge.otherEnd, point: node.point });
    }
  }

  const writes: Write[] = [{ parts, after: target, material: Math.abs(before.thickness - target.thickness) > THICKNESS_TOL ? planMaterial(g, parts, target.thickness) : { kind: "none" } }];
  const changes: WallChange[] = [{ globalId: guid, kind: "updated", cause: "requested", before, after: target }];
  for (const other of order) {
    const otherGuid = guidOf(g, other);
    const otherParts = parseWall(g, otherGuid);
    assertEditable(g, otherParts);
    if ((topo.get(other) ?? []).some((e) => !e.supported))
      fail("unsupported-connection", `Connected wall ${otherGuid} has a path/T-junction connection and cannot follow the move.`);
    const o = overrides.get(other)!;
    const after: WallGeometry = { ...otherParts.geometry, start: o.start ?? otherParts.geometry.start, end: o.end ?? otherParts.geometry.end };
    validateWallGeometry(after, `Connected wall ${otherGuid}`);
    writes.push({ parts: otherParts, after, material: { kind: "none" } });
    changes.push({ globalId: otherGuid, kind: "updated", cause: "connected", before: otherParts.geometry, after });
  }
  return { changes, writes };
}

function writeGeometry(g: Graph, parts: WallParts, geometry: WallGeometry, material: MaterialPlan): void {
  const { api, id } = g;
  const len = api.CreateIfcType.bind(api, id, IFCLENGTHMEASURE);
  const real = api.CreateIfcType.bind(api, id, IFCREAL);
  const dx = geometry.end[0] - geometry.start[0], dy = geometry.end[1] - geometry.start[1];
  const length = Math.hypot(dx, dy);
  const ux = dx / length, uy = dy / length;
  const c = Math.cos(parts.parent.yawRadians), s = Math.sin(parts.parent.yawRadians);
  const px = geometry.start[0] - parts.parent.position[0], py = geometry.start[1] - parts.parent.position[1];
  const point = g.line(parts.pointId);
  point.Coordinates = [len(clean(c * px + s * py)), len(clean(-s * px + c * py)), len(clean(geometry.elevation - parts.parent.position[2]))];
  api.WriteLine(id, point);
  const direction = [real(clean(c * ux + s * uy)), real(clean(-s * ux + c * uy)), real(0)];
  const axis = g.line(parts.axisId);
  if (parts.refDirectionId !== null) {
    const d = g.line(parts.refDirectionId);
    d.DirectionRatios = direction;
    api.WriteLine(id, d);
  } else {
    axis.RefDirection = api.CreateIfcEntity(id, IFCDIRECTION, direction);
    api.WriteLine(id, axis);
  }
  const t = geometry.thickness;
  const list = g.line(parts.listId);
  list.CoordList = [[0, 0], [0, t], [length, t], [length, 0], [0, 0]].map((p) => p.map((v) => len(clean(v!))));
  api.WriteLine(id, list);
  const solid = g.line(parts.solidId);
  solid.Depth = api.CreateIfcType(id, IFCPOSITIVELENGTHMEASURE, geometry.height);
  api.WriteLine(id, solid);
  // The Axis is the wall-local segment (0,0)->(length,0), the same line the Body spans.
  if (parts.axis?.kind === "indexed") {
    const axisList = g.line(parts.axis.listId);
    axisList.CoordList = [[0, 0], [length, 0]].map((p) => p.map((v) => len(clean(v!))));
    api.WriteLine(id, axisList);
  } else if (parts.axis?.kind === "polyline") {
    parts.axis.pointIds.forEach((pid, i) => {
      const axisPoint = g.line(pid);
      axisPoint.Coordinates = [len(i === 0 ? 0 : clean(length)), len(0)];
      api.WriteLine(id, axisPoint);
    });
  }
  applyMaterial(g, material, geometry.thickness);
}

export function planWallUpdate(api: IfcAPI, bytes: Uint8Array, globalId: string, target: WallGeometry): WallChange[] {
  return model(api, bytes, (id) => planUpdate(graph(api, id), globalId, target).changes);
}

/** Updates endpoints/thickness/height/elevation; connected path-element ends move with it. */
export function updateWall(api: IfcAPI, bytes: Uint8Array, globalId: string, target: WallGeometry): Uint8Array {
  return model(api, bytes, (id) => {
    const g = graph(api, id);
    const { writes } = planUpdate(g, globalId, target);
    if (!writes.length) return bytes.slice();
    for (const w of writes) writeGeometry(g, w.parts, w.after, w.material);
    return api.SaveModel(id);
  });
}

// ---------------------------------------------------------------- create

function planCreate(g: Graph, input: CreateWallInput) {
  if (typeof input.globalId !== "string" || !GUID.test(input.globalId)) fail("invalid-global-id", "Wall GlobalId must be a 22-character compressed IFC GUID.");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 256) fail("invalid-name", "Wall name must contain 1-256 nonblank characters.");
  validateWallGeometry(input.geometry, "New wall");
  if (g.allGlobalIds().has(input.globalId)) fail("duplicate-global-id", `GlobalId ${input.globalId} already exists in the IFC model.`);
  let storeyId: number | undefined;
  const storeys = g.api.GetLineIDsWithType(g.id, IFCBUILDINGSTOREY);
  for (let i = 0; i < storeys.size(); i++) if (g.line(storeys.get(i)).GlobalId?.value === input.storeyGlobalId) storeyId = storeys.get(i);
  if (storeyId === undefined) return fail("storey-not-found", `No IfcBuildingStorey has GlobalId ${input.storeyGlobalId}.`);
  const containment = g.referrers(storeyId).filter((r) => g.type(r) === IFCRELCONTAINEDINSPATIALSTRUCTURE && refId(g.line(r).RelatingStructure) === storeyId);
  if (containment.length !== 1) fail("storey-containment-unsupported", "The storey must have exactly one IfcRelContainedInSpatialStructure to receive the wall.");
  const contexts: number[] = [];
  const ctxIds = g.api.GetLineIDsWithType(g.id, IFCGEOMETRICREPRESENTATIONSUBCONTEXT);
  for (let i = 0; i < ctxIds.size(); i++) {
    const c = g.line(ctxIds.get(i));
    if (c.ContextIdentifier?.value === "Body" && c.ContextType?.value === "Model") contexts.push(ctxIds.get(i));
  }
  if (contexts.length !== 1) fail("body-context-missing", "A unique IFC Model/Body representation context is required.");
  // Optional Plan/Axis context: when present (and unique) the wall also gets an Axis and a layer-set usage.
  const axisContexts: number[] = [];
  for (let i = 0; i < ctxIds.size(); i++) {
    const c = g.line(ctxIds.get(i));
    if (c.ContextIdentifier?.value === "Axis" && c.ContextType?.value === "Plan") axisContexts.push(ctxIds.get(i));
  }
  const storeyPlacementId = refId(g.line(storeyId).ObjectPlacement);
  return { storeyPlacementId, containmentId: containment[0]!, contextId: contexts[0]!, axisContextId: axisContexts.length === 1 ? axisContexts[0]! : null };
}

export function planWallCreate(api: IfcAPI, bytes: Uint8Array, input: CreateWallInput): WallChange[] {
  return model(api, bytes, (id) => {
    planCreate(graph(api, id), input);
    return [{ globalId: input.globalId, kind: "created", cause: "requested", before: null, after: input.geometry }];
  });
}

export function createWall(api: IfcAPI, bytes: Uint8Array, input: CreateWallInput): Uint8Array {
  return model(api, bytes, (id) => {
    const g = graph(api, id);
    const { storeyPlacementId, containmentId, contextId, axisContextId } = planCreate(g, input);
    let parent = { position: [0, 0, 0] as readonly [number, number, number], yawRadians: 0 };
    if (storeyPlacementId !== null) {
      try { parent = chain(api, id, { value: storeyPlacementId }).pose; }
      catch (e) { fail("unsupported-placement", `Storey placement: ${(e as Error).message}`); }
    }
    const geometry = input.geometry;
    const len = api.CreateIfcType.bind(api, id, IFCLENGTHMEASURE);
    const real = api.CreateIfcType.bind(api, id, IFCREAL);
    const label = (v: string) => api.CreateIfcType(id, IFCLABEL, v);
    const dx = geometry.end[0] - geometry.start[0], dy = geometry.end[1] - geometry.start[1];
    const length = Math.hypot(dx, dy), ux = dx / length, uy = dy / length;
    const c = Math.cos(parent.yawRadians), s = Math.sin(parent.yawRadians);
    const px = geometry.start[0] - parent.position[0], py = geometry.start[1] - parent.position[1];
    const point = api.CreateIfcEntity(id, IFCCARTESIANPOINT, [len(clean(c * px + s * py)), len(clean(-s * px + c * py)), len(clean(geometry.elevation - parent.position[2]))]);
    const zAxis = api.CreateIfcEntity(id, IFCDIRECTION, [real(0), real(0), real(1)]);
    const xAxis = api.CreateIfcEntity(id, IFCDIRECTION, [real(clean(c * ux + s * uy)), real(clean(-s * ux + c * uy)), real(0)]);
    const relative = api.CreateIfcEntity(id, IFCAXIS2PLACEMENT3D, point, zAxis, xAxis);
    const placement = api.CreateIfcEntity(id, IFCLOCALPLACEMENT, storeyPlacementId === null ? null : new Handle(storeyPlacementId), relative);
    const t = geometry.thickness;
    const list = api.CreateIfcEntity(id, IFCCARTESIANPOINTLIST2D, [[0, 0], [0, t], [length, t], [length, 0], [0, 0]].map((p) => p.map((v) => len(clean(v!)))));
    const curve = api.CreateIfcEntity(id, IFCINDEXEDPOLYCURVE, list, null, null);
    const profile = api.CreateIfcEntity(id, IFCARBITRARYCLOSEDPROFILEDEF, IFC4.IfcProfileTypeEnum.AREA, null, curve);
    const origin = api.CreateIfcEntity(id, IFCCARTESIANPOINT, [len(0), len(0), len(0)]);
    const position = api.CreateIfcEntity(id, IFCAXIS2PLACEMENT3D, origin, api.CreateIfcEntity(id, IFCDIRECTION, [real(0), real(0), real(1)]), api.CreateIfcEntity(id, IFCDIRECTION, [real(1), real(0), real(0)]));
    const solid = api.CreateIfcEntity(id, IFCEXTRUDEDAREASOLID, profile, position, api.CreateIfcEntity(id, IFCDIRECTION, [real(0), real(0), real(1)]), api.CreateIfcType(id, IFCPOSITIVELENGTHMEASURE, geometry.height));
    const rep = api.CreateIfcEntity(id, IFCSHAPEREPRESENTATION, new Handle(contextId), label("Body"), label("SweptSolid"), [solid]);
    const reps: unknown[] = [rep];
    if (axisContextId !== null) {
      // Same convention as teldra_ifc.bim.add_wall_axis_and_layers: Axis (0,0)->(L,0) in wall-local XY.
      const axisList = api.CreateIfcEntity(id, IFCCARTESIANPOINTLIST2D, [[0, 0], [length, 0]].map((p) => p.map((v) => len(clean(v!)))));
      const axisCurve = api.CreateIfcEntity(id, IFCINDEXEDPOLYCURVE, axisList, null, null);
      reps.push(api.CreateIfcEntity(id, IFCSHAPEREPRESENTATION, new Handle(axisContextId), label("Axis"), label("Curve2D"), [axisCurve]));
    }
    const shape = api.CreateIfcEntity(id, IFCPRODUCTDEFINITIONSHAPE, null, null, reps);
    const wall = api.CreateIfcEntity(id, IFCWALL, api.CreateIfcType(id, IFCGLOBALLYUNIQUEID, input.globalId), null, label(input.name), null, label("TeldraAuthoringStraightWall"), placement, shape, null, null);
    api.WriteLine(id, wall);
    if (!Number.isInteger(wall.expressID) || wall.expressID <= 0) fail("shared-geometry", "web-ifc did not assign an express ID to the new wall.");
    const rel = g.line(containmentId);
    rel.RelatedElements = [...rel.RelatedElements, new Handle(wall.expressID)];
    api.WriteLine(id, rel);
    if (axisContextId !== null) {
      const layerSetId = acquireLayerSet(g, geometry.thickness, null);
      const usage = api.CreateIfcEntity(id, IFCMATERIALLAYERSETUSAGE, new Handle(layerSetId), IFC4.IfcLayerSetDirectionEnum.AXIS2, IFC4.IfcDirectionSenseEnum.POSITIVE, len(0), null);
      api.WriteLine(id, usage);
      const relGuid = derivedGuid(`${input.globalId}:material`, g.allGlobalIds());
      api.WriteLine(id, api.CreateIfcEntity(id, IFCRELASSOCIATESMATERIAL, api.CreateIfcType(id, IFCGLOBALLYUNIQUEID, relGuid), null, null, null, [new Handle(wall.expressID)], new Handle(usage.expressID)));
    }
    return api.SaveModel(id);
  });
}

// ---------------------------------------------------------------- remove

function planRemove(g: Graph, guid: string) {
  const parts = parseWall(g, guid);
  const wallId = parts.wall.expressID;
  let containmentId: number | null = null;
  for (const r of g.referrers(wallId)) {
    const t = g.type(r);
    if (t === IFCRELVOIDSELEMENT) fail("hosted-opening", `Wall ${guid} hosts an opening; remove or re-host the opening first.`);
    if (t === IFCRELCONTAINEDINSPATIALSTRUCTURE) { containmentId = r; continue; }
    fail("wall-referenced", `Wall ${guid} is referenced by another IFC relationship (type ${t}) and cannot be removed standalone.`);
  }
  assertEditable(g, parts);
  return { parts, containmentId };
}

export function planWallRemove(api: IfcAPI, bytes: Uint8Array, globalId: string): WallChange[] {
  return model(api, bytes, (id) => {
    const { parts } = planRemove(graph(api, id), globalId);
    return [{ globalId, kind: "removed", cause: "requested", before: parts.geometry, after: null }];
  });
}

/** Removes a standalone wall (contained in a storey, nothing else referencing it) and its owned geometry. */
export function removeWall(api: IfcAPI, bytes: Uint8Array, globalId: string): Uint8Array {
  return model(api, bytes, (id) => {
    const g = graph(api, id);
    const { parts, containmentId } = planRemove(g, globalId);
    if (containmentId !== null) {
      const rel = g.line(containmentId);
      const rest = (rel.RelatedElements as any[]).filter((r) => refId(r) !== parts.wall.expressID);
      if (rest.length) { rel.RelatedElements = rest; api.WriteLine(id, rel); } else api.DeleteLine(id, containmentId);
    }
    for (const e of parts.owned) api.DeleteLine(id, e);
    return api.SaveModel(id);
  });
}

// ---------------------------------------------------------------- application adapter

export type WallOperation =
  | { readonly kind: "update"; readonly globalId: string; readonly geometry: WallGeometry }
  | { readonly kind: "create"; readonly globalId: string; readonly storeyGlobalId: string; readonly name: string; readonly geometry: WallGeometry }
  | { readonly kind: "remove"; readonly globalId: string };

/**
 * Structurally implements `IfcWallAdapter` from @teldra/application without importing it,
 * keeping this integration package free of a runtime dependency on the application layer.
 */
export function createIfcWallAdapter(api: IfcAPI) {
  return {
    read: (bytes: Uint8Array, globalId: string): WallRecord => readWall(api, bytes, globalId),
    plan: (bytes: Uint8Array, op: WallOperation): WallChange[] =>
      op.kind === "update" ? planWallUpdate(api, bytes, op.globalId, op.geometry)
        : op.kind === "create" ? planWallCreate(api, bytes, op)
          : planWallRemove(api, bytes, op.globalId),
    apply: (bytes: Uint8Array, op: WallOperation): Uint8Array =>
      op.kind === "update" ? updateWall(api, bytes, op.globalId, op.geometry)
        : op.kind === "create" ? createWall(api, bytes, op)
          : removeWall(api, bytes, op.globalId),
  };
}
