/**
 * Renderer-independent 2D plan projection of canonical IFC building data.
 *
 * Canonical frame: IFC world metres, X east, Y north, Z up. Plan frame: view pixels, X right, Y DOWN
 * (SVG/canvas convention), so the Y axis is flipped explicitly by {@link canonicalToPlan}. A plan
 * projection never carries drag, camera or selection state and is rebuilt from canonical data; every
 * projected item resolves back to its IFC GlobalId (and, when supplied, its Teldra canonical id).
 */
export type PlanPoint = readonly [x: number, y: number];

/** Canonical -> plan transform. `centre` is the canonical point drawn at the middle of the view. */
export interface PlanViewport {
  readonly centre: PlanPoint;
  readonly pixelsPerMetre: number;
  readonly width: number;
  readonly height: number;
}

export function assertPlanViewport(viewport: PlanViewport): void {
  const { centre, pixelsPerMetre, width, height } = viewport;
  if (![centre[0], centre[1], pixelsPerMetre, width, height].every(Number.isFinite) || pixelsPerMetre <= 0 || width <= 0 || height <= 0)
    throw new Error("Plan viewport needs a finite centre, positive scale and positive size.");
}
export function canonicalToPlan(viewport: PlanViewport, point: PlanPoint): PlanPoint {
  return [
    viewport.width / 2 + (point[0] - viewport.centre[0]) * viewport.pixelsPerMetre,
    viewport.height / 2 - (point[1] - viewport.centre[1]) * viewport.pixelsPerMetre,
  ];
}
export function planToCanonical(viewport: PlanViewport, point: PlanPoint): PlanPoint {
  return [
    viewport.centre[0] + (point[0] - viewport.width / 2) / viewport.pixelsPerMetre,
    viewport.centre[1] - (point[1] - viewport.height / 2) / viewport.pixelsPerMetre,
  ];
}

export interface PlanSourceStorey { readonly globalId: string; readonly name: string; readonly elevation: number }
export interface PlanSourceWall {
  readonly globalId: string;
  readonly name: string;
  readonly storeyGlobalId: string | null;
  readonly start: PlanPoint;
  readonly end: PlanPoint;
  readonly thickness: number;
  readonly height: number;
  readonly elevation: number;
  readonly connections: readonly { readonly wallGlobalId: string; readonly end: "start" | "end"; readonly otherEnd: "start" | "end" }[];
  /** True when an IfcOpeningElement voids this wall; such walls are not editable yet. */
  readonly hostsOpenings: boolean;
}
export interface PlanSourceSpace {
  readonly globalId: string;
  readonly name: string;
  readonly storeyGlobalId: string | null;
  /** Closed ring in canonical metres, without repeating the first point. */
  readonly footprint: readonly PlanPoint[];
}
export interface PlanSourceOpening {
  readonly globalId: string;
  readonly hostWallGlobalId: string;
  readonly kind: "opening" | "door" | "window";
  readonly footprint: readonly PlanPoint[];
}
/** Canonical, unit-explicit input read from IFC by an adapter (see @teldra/ifc-edit `readPlanSource`). */
export interface PlanSource {
  readonly unit: "metre";
  readonly storeys: readonly PlanSourceStorey[];
  readonly walls: readonly PlanSourceWall[];
  readonly spaces: readonly PlanSourceSpace[];
  readonly openings: readonly PlanSourceOpening[];
  /** Elements present in IFC that the plan reader could not interpret; never silently dropped. */
  readonly unreadable?: readonly { readonly globalId: string; readonly kind: "wall" | "space" | "opening"; readonly reason: string }[];
}

export interface PlanIdentity { readonly ifcGlobalId: string; readonly canonicalId: string | null }
type Quad = readonly [PlanPoint, PlanPoint, PlanPoint, PlanPoint];
export interface PlanWall extends PlanIdentity {
  readonly kind: "wall";
  readonly name: string;
  /** Reference (axis) line in canonical metres: IFC wall start -> end. */
  readonly start: PlanPoint;
  readonly end: PlanPoint;
  readonly thickness: number;
  readonly height: number;
  readonly elevation: number;
  readonly length: number;
  /** Body rectangle in canonical metres: IFC walls extend `thickness` to the LEFT of start->end. */
  readonly outline: Quad;
  /** The same outline in plan (pixel) coordinates. */
  readonly planOutline: Quad;
  readonly planStart: PlanPoint;
  readonly planEnd: PlanPoint;
  readonly connections: PlanSourceWall["connections"];
  readonly hostsOpenings: boolean;
  /** True for geometry coming from a preview overlay rather than committed canonical data. */
  readonly preview: boolean;
}
export interface PlanSpace extends PlanIdentity { readonly kind: "space"; readonly name: string; readonly footprint: readonly PlanPoint[]; readonly planFootprint: readonly PlanPoint[] }
export interface PlanOpening extends PlanIdentity {
  readonly kind: "opening"; readonly openingKind: PlanSourceOpening["kind"]; readonly hostWallGlobalId: string;
  readonly footprint: readonly PlanPoint[]; readonly planFootprint: readonly PlanPoint[];
}
export interface StoreyPlan {
  readonly storey: PlanSourceStorey;
  readonly viewport: PlanViewport;
  readonly walls: readonly PlanWall[];
  readonly spaces: readonly PlanSpace[];
  readonly openings: readonly PlanOpening[];
}

export interface PlanProjectionOptions {
  /** IFC GlobalId -> Teldra canonical id, from the identity map. Unmapped elements keep `canonicalId: null`. */
  readonly canonicalIdByGlobalId?: ReadonlyMap<string, string> | undefined;
}

/** Wall body rectangle: start, end, end+left*thickness, start+left*thickness. */
export function wallOutline(start: PlanPoint, end: PlanPoint, thickness: number): Quad {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  const nx = length > 0 ? (-dy / length) * thickness : 0, ny = length > 0 ? (dx / length) * thickness : 0;
  return [start, end, [end[0] + nx, end[1] + ny], [start[0] + nx, start[1] + ny]];
}

interface WallInput {
  readonly globalId: string; readonly name: string;
  readonly start: PlanPoint; readonly end: PlanPoint; readonly thickness: number; readonly height: number; readonly elevation: number;
  readonly connections: PlanSourceWall["connections"]; readonly hostsOpenings: boolean;
}
function projectWall(viewport: PlanViewport, wall: WallInput, options: PlanProjectionOptions, preview: boolean): PlanWall {
  const outline = wallOutline(wall.start, wall.end, wall.thickness);
  return {
    kind: "wall", ifcGlobalId: wall.globalId, canonicalId: options.canonicalIdByGlobalId?.get(wall.globalId) ?? null, name: wall.name,
    start: wall.start, end: wall.end, thickness: wall.thickness, height: wall.height, elevation: wall.elevation,
    length: Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]),
    outline, planOutline: outline.map((p) => canonicalToPlan(viewport, p)) as unknown as Quad,
    planStart: canonicalToPlan(viewport, wall.start), planEnd: canonicalToPlan(viewport, wall.end),
    connections: wall.connections, hostsOpenings: wall.hostsOpenings, preview,
  };
}

/** Default viewport framing every item of the storey with a margin; deterministic for a given source. */
export function frameStoreyPlan(source: PlanSource, storeyGlobalId: string, size: { readonly width: number; readonly height: number }, marginMetres = 1): PlanViewport {
  const points: PlanPoint[] = [];
  for (const w of source.walls) if (w.storeyGlobalId === storeyGlobalId) points.push(...wallOutline(w.start, w.end, w.thickness));
  for (const s of source.spaces) if (s.storeyGlobalId === storeyGlobalId) points.push(...s.footprint);
  if (!points.length) return { centre: [0, 0], pixelsPerMetre: 32, width: size.width, height: size.height };
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const minX = Math.min(...xs) - marginMetres, maxX = Math.max(...xs) + marginMetres;
  const minY = Math.min(...ys) - marginMetres, maxY = Math.max(...ys) + marginMetres;
  const scale = Math.min(size.width / (maxX - minX), size.height / (maxY - minY));
  return { centre: [(minX + maxX) / 2, (minY + maxY) / 2], pixelsPerMetre: Math.min(Math.max(scale, 4), 200), width: size.width, height: size.height };
}

/** Projects the walls, spaces and openings of one storey. Pure: same source + viewport -> same output. */
export function projectStoreyPlan(source: PlanSource, storeyGlobalId: string, viewport: PlanViewport, options: PlanProjectionOptions = {}): StoreyPlan {
  assertPlanViewport(viewport);
  const storey = source.storeys.find((s) => s.globalId === storeyGlobalId);
  if (!storey) throw new Error(`Unknown storey ${storeyGlobalId}.`);
  const identity = (id: string): PlanIdentity => ({ ifcGlobalId: id, canonicalId: options.canonicalIdByGlobalId?.get(id) ?? null });
  const walls = source.walls.filter((w) => w.storeyGlobalId === storeyGlobalId).map((w) => projectWall(viewport, w, options, false));
  const wallIds = new Set(walls.map((w) => w.ifcGlobalId));
  const toPlan = (ring: readonly PlanPoint[]) => ring.map((p) => canonicalToPlan(viewport, p));
  const spaces = source.spaces.filter((s) => s.storeyGlobalId === storeyGlobalId).map((s): PlanSpace => ({
    kind: "space", ...identity(s.globalId), name: s.name, footprint: s.footprint, planFootprint: toPlan(s.footprint),
  }));
  const openings = source.openings.filter((o) => wallIds.has(o.hostWallGlobalId)).map((o): PlanOpening => ({
    kind: "opening", ...identity(o.globalId), openingKind: o.kind, hostWallGlobalId: o.hostWallGlobalId, footprint: o.footprint, planFootprint: toPlan(o.footprint),
  }));
  return { storey, viewport, walls, spaces, openings };
}

export interface PlanWallChange {
  readonly globalId: string;
  readonly kind: "created" | "updated" | "removed";
  readonly after: { readonly start: PlanPoint; readonly end: PlanPoint; readonly thickness: number; readonly height: number; readonly elevation: number } | null;
}

/**
 * Overlays a previewed edit (e.g. `IfcWallEditor.preview().changes`) on a committed plan. Changed walls
 * (including connected neighbours) are flagged `preview`; removed walls disappear; created walls are added.
 * Never mutates the input plan or canonical data.
 */
export function overlayWallChanges(plan: StoreyPlan, changes: readonly PlanWallChange[], options: PlanProjectionOptions = {}): StoreyPlan {
  const byId = new Map(changes.map((c) => [c.globalId, c]));
  const walls: PlanWall[] = [];
  for (const wall of plan.walls) {
    const change = byId.get(wall.ifcGlobalId);
    if (!change) { walls.push(wall); continue; }
    if (change.kind === "removed" || !change.after) continue;
    walls.push(projectWall(plan.viewport, { ...wall, globalId: wall.ifcGlobalId, ...change.after }, options, true));
  }
  for (const change of changes) {
    if (change.kind === "created" && change.after && !plan.walls.some((w) => w.ifcGlobalId === change.globalId))
      walls.push(projectWall(plan.viewport, { globalId: change.globalId, name: "New wall", ...change.after, connections: [], hostsOpenings: false }, options, true));
  }
  return { ...plan, walls };
}
