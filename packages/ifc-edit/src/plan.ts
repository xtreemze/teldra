import {
  IFCARBITRARYCLOSEDPROFILEDEF, IFCAXIS2PLACEMENT2D, IFCBUILDINGSTOREY, IFCCARTESIANPOINT, IFCCARTESIANPOINTLIST2D, IFCDOOR,
  IFCEXTRUDEDAREASOLID, IFCINDEXEDPOLYCURVE, IFCOPENINGELEMENT, IFCPOLYLINE, IFCRECTANGLEPROFILEDEF, IFCRELAGGREGATES,
  IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELFILLSELEMENT, IFCRELVOIDSELEMENT, IFCSHAPEREPRESENTATION, IFCSPACE, IFCWINDOW,
  type IfcAPI,
} from "web-ifc";
import type { PlanPoint, PlanSource, PlanSourceOpening, PlanSourceSpace, PlanSourceStorey, PlanSourceWall } from "@teldra/projection";
import { chain, model, type Line } from "./ifc-session.js";
import { wallInternals, type WallGraph } from "./wall.js";

/**
 * Read-only extraction of storey plan data (walls, spaces, opening footprints) from canonical IFC4 metre
 * models. Output is explicit IFC world metres (X east, Y north); nothing is written and no GlobalId is
 * generated. Anything that cannot be interpreted is reported in `unreadable` rather than dropped silently.
 */
const refId = (v: any): number | null => (v != null && typeof v === "object" && Number.isInteger(v.value) ? (v.value as number) : null);
const EPS = 1e-9;

function ringOfProfile(g: WallGraph, profileId: number): PlanPoint[] | null {
  const profile = g.line(profileId);
  const type = g.type(profileId);
  if (type === IFCRECTANGLEPROFILEDEF) {
    const x = profile.XDim?.value, y = profile.YDim?.value;
    if (!(x > 0 && y > 0)) return null;
    let centre: PlanPoint = [0, 0], ux: PlanPoint = [1, 0];
    const positionId = refId(profile.Position);
    if (positionId !== null) {
      const position = g.line(positionId);
      if (g.type(positionId) !== IFCAXIS2PLACEMENT2D) return null;
      const location = g.line(refId(position.Location)!);
      centre = [location.Coordinates[0].value, location.Coordinates[1].value];
      const dirId = refId(position.RefDirection);
      if (dirId !== null) { const r = g.line(dirId).DirectionRatios.map((v: any) => v.value) as number[]; const n = Math.hypot(r[0]!, r[1]!); if (n < EPS) return null; ux = [r[0]! / n, r[1]! / n]; }
    }
    const uy: PlanPoint = [-ux[1], ux[0]];
    const corner = (sx: number, sy: number): PlanPoint => [centre[0] + sx * (x / 2) * ux[0] + sy * (y / 2) * uy[0], centre[1] + sx * (x / 2) * ux[1] + sy * (y / 2) * uy[1]];
    return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  }
  if (type !== IFCARBITRARYCLOSEDPROFILEDEF) return null;
  const curveId = refId(profile.OuterCurve);
  if (curveId === null) return null;
  const curve = g.line(curveId);
  let points: PlanPoint[] | null = null;
  if (g.type(curveId) === IFCPOLYLINE && Array.isArray(curve.Points)) {
    points = curve.Points.map((p: any) => g.line(refId(p)!)).map((p: Line) => (g.type(p.expressID) === IFCCARTESIANPOINT && p.Coordinates.length >= 2 ? [p.Coordinates[0].value, p.Coordinates[1].value] as PlanPoint : null)) as any;
    if (points!.some((p) => p === null)) return null;
  } else if (g.type(curveId) === IFCINDEXEDPOLYCURVE && !curve.Segments) {
    const listId = refId(curve.Points);
    if (listId === null || g.type(listId) !== IFCCARTESIANPOINTLIST2D) return null;
    points = (g.line(listId).CoordList as any[]).map((p) => [p[0].value, p[1].value] as PlanPoint);
  }
  if (!points || points.length < 3 || !points.flat().every(Number.isFinite)) return null;
  const first = points[0]!, last = points[points.length - 1]!;
  return Math.hypot(first[0] - last[0], first[1] - last[1]) < EPS ? points.slice(0, -1) : points;
}

/** World-space footprint of an element's Body/SweptSolid extrusion (upright, identity extrusion frame), or a reason. */
function footprintOf(g: WallGraph, element: Line): { ring: PlanPoint[] } | { reason: string } {
  try {
    if (!element.ObjectPlacement) return { reason: "no placement" };
    const { pose } = chain(g.api, g.id, element.ObjectPlacement);
    const pdsId = refId(element.Representation);
    if (pdsId === null) return { reason: "no representation" };
    const reps = ((g.line(pdsId).Representations as any[]) ?? []).map((r) => g.line(refId(r)!));
    const body = reps.find((r) => g.type(r.expressID) === IFCSHAPEREPRESENTATION && r.RepresentationIdentifier?.value === "Body" && r.RepresentationType?.value === "SweptSolid");
    const solidId = refId(body?.Items?.[0]);
    if (solidId === null || g.type(solidId) !== IFCEXTRUDEDAREASOLID) return { reason: "no Body/SweptSolid extrusion" };
    const solid = g.line(solidId);
    const position = g.line(refId(solid.Position)!);
    if (position.Axis || position.RefDirection) return { reason: "rotated extrusion frame" };
    const origin = g.line(refId(position.Location)!).Coordinates.map((v: any) => v.value) as number[];
    const local = ringOfProfile(g, refId(solid.SweptArea)!);
    if (!local) return { reason: "unsupported footprint profile" };
    const c = Math.cos(pose.yawRadians), s = Math.sin(pose.yawRadians);
    return { ring: local.map(([x, y]): PlanPoint => {
      const lx = x + origin[0]!, ly = y + origin[1]!;
      return [pose.position[0] + c * lx - s * ly, pose.position[1] + s * lx + c * ly];
    }) };
  } catch (error) { return { reason: error instanceof Error ? error.message : String(error) }; }
}

export function readPlanSource(api: IfcAPI, bytes: Uint8Array): PlanSource {
  return model(api, bytes, (id) => {
    const g = wallInternals.graph(api, id);
    const ids = (type: number): number[] => { const v = api.GetLineIDsWithType(id, type); return Array.from({ length: v.size() }, (_, i) => v.get(i)); };
    const storeys: PlanSourceStorey[] = ids(IFCBUILDINGSTOREY).map((e) => {
      const line = g.line(e);
      let elevation = typeof line.Elevation?.value === "number" ? line.Elevation.value : 0;
      try { elevation = chain(api, id, line.ObjectPlacement).pose.position[2]; } catch { /* keep declared Elevation */ }
      return { globalId: line.GlobalId.value, name: line.Name?.value ?? "Storey", elevation };
    });
    const storeyOf = new Map<number, string>();
    const storeyIds = new Map(ids(IFCBUILDINGSTOREY).map((e) => [e, g.line(e).GlobalId.value as string]));
    for (const e of ids(IFCRELCONTAINEDINSPATIALSTRUCTURE)) {
      const rel = g.line(e), storey = storeyIds.get(refId(rel.RelatingStructure) ?? -1);
      if (storey) for (const el of rel.RelatedElements ?? []) storeyOf.set(refId(el)!, storey);
    }
    for (const e of ids(IFCRELAGGREGATES)) {
      const rel = g.line(e), storey = storeyIds.get(refId(rel.RelatingObject) ?? -1);
      if (storey) for (const el of rel.RelatedObjects ?? []) storeyOf.set(refId(el)!, storey);
    }

    const unreadable: { globalId: string; kind: "wall" | "space" | "opening"; reason: string }[] = [];
    const topo = wallInternals.topology(g);
    const voids = ids(IFCRELVOIDSELEMENT).map((e) => g.line(e));
    const hostIds = new Set(voids.map((r) => refId(r.RelatingBuildingElement)).filter((v): v is number => v !== null));
    const walls: PlanSourceWall[] = [];
    for (const [guid, expressID] of [...g.wallsByGuid()].sort((a, b) => a[1] - b[1])) {
      try {
        const parts = wallInternals.parseWall(g, guid);
        const connections = (topo.get(expressID) ?? []).filter((e) => e.supported)
          .map((e) => ({ wallGlobalId: wallInternals.guidOf(g, e.other), end: e.end, otherEnd: e.otherEnd }));
        walls.push({
          globalId: guid, name: g.line(expressID).Name?.value ?? guid, storeyGlobalId: storeyOf.get(expressID) ?? null,
          start: parts.geometry.start, end: parts.geometry.end, thickness: parts.geometry.thickness, height: parts.geometry.height,
          elevation: parts.geometry.elevation, connections, hostsOpenings: hostIds.has(expressID),
        });
      } catch (error) { unreadable.push({ globalId: guid, kind: "wall", reason: error instanceof Error ? error.message : String(error) }); }
    }

    const spaces: PlanSourceSpace[] = [];
    for (const e of ids(IFCSPACE)) {
      const line = g.line(e), globalId = line.GlobalId.value as string;
      const fp = footprintOf(g, line);
      if ("ring" in fp) spaces.push({ globalId, name: line.Name?.value ?? globalId, storeyGlobalId: storeyOf.get(e) ?? null, footprint: fp.ring });
      else unreadable.push({ globalId, kind: "space", reason: fp.reason });
    }

    const fillers = new Map<number, number>();
    for (const e of ids(IFCRELFILLSELEMENT)) { const rel = g.line(e); const o = refId(rel.RelatingOpeningElement), f = refId(rel.RelatedBuildingElement); if (o !== null && f !== null) fillers.set(o, f); }
    const wallGuidByExpress = new Map([...g.wallsByGuid()].map(([guid, e]) => [e, guid]));
    const openings: PlanSourceOpening[] = [];
    for (const rel of voids) {
      const hostId = refId(rel.RelatingBuildingElement), openingId = refId(rel.RelatedOpeningElement);
      const host = hostId === null ? undefined : wallGuidByExpress.get(hostId);
      if (!host || openingId === null || g.type(openingId) !== IFCOPENINGELEMENT) continue;
      const opening = g.line(openingId), globalId = opening.GlobalId.value as string;
      const fp = footprintOf(g, opening);
      if (!("ring" in fp)) { if (fp.reason !== "no placement" && fp.reason !== "no representation") unreadable.push({ globalId, kind: "opening", reason: fp.reason }); continue; }
      const filler = fillers.get(openingId);
      const fillerType = filler === undefined ? null : g.type(filler);
      openings.push({ globalId, hostWallGlobalId: host, kind: fillerType === IFCDOOR ? "door" : fillerType === IFCWINDOW ? "window" : "opening", footprint: fp.ring });
    }
    return { unit: "metre", storeys, walls, spaces, openings, unreadable };
  });
}
