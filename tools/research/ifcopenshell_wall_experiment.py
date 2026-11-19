"""IfcOpenShell wall / opening / mitre / space experiment (REF research, #125/#135).

Pure ifcopenshell + numpy, so the SAME file runs under native CPython (ifcopenshell 0.9.x)
and under Pyodide (WASM ifcopenshell wheels). It builds a four-wall room from scratch with
the public ifcopenshell.api, then exercises: connect_path mitring, door + void + filling,
opening re-hosting, wall endpoint move + geometry regeneration, space footprint recompute and
ifcopenshell.validate. Results are printed as one JSON document (key RESULT) with timings.

Usage (native):  python tools/research/ifcopenshell_wall_experiment.py [out.ifc]
The Pyodide harness (tools/research/pyodide_wall_experiment.mjs) execs this file's source.
"""
from __future__ import annotations

import json
import sys
import time

import numpy as np

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.api.aggregate
import ifcopenshell.api.context
import ifcopenshell.api.feature
import ifcopenshell.api.geometry
import ifcopenshell.api.material
import ifcopenshell.api.project
import ifcopenshell.api.root
import ifcopenshell.api.spatial
import ifcopenshell.api.unit
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.placement
import ifcopenshell.util.representation
import ifcopenshell.util.shape
import ifcopenshell.util.shape_builder
import ifcopenshell.validate

R: dict = {"ifcopenshell": ifcopenshell.version, "py": sys.version.split()[0], "steps": {}}
api = ifcopenshell.api.run


def timed(name):
    class _T:
        def __enter__(self):
            R["steps"].setdefault(name, {})
            self.t = time.perf_counter()

        def __exit__(self, *a):
            R["steps"].setdefault(name, {})["ms"] = round((time.perf_counter() - self.t) * 1000, 1)

    return _T()


SET = ifcopenshell.geom.settings()
SET.set("use-world-coords", True)


def shape_of(f, el):
    """Triangulated geometry of one element (with openings applied) -> (volume, bbox)."""
    s = ifcopenshell.geom.create_shape(SET, el)
    verts = ifcopenshell.util.shape.get_vertices(s.geometry)
    vol = float(ifcopenshell.util.shape.get_volume(s.geometry))
    bb = [round(float(x), 3) for x in (*verts.min(0), *verts.max(0))] if verts.size else None
    return round(vol, 4), bb


def build(f=None):
    f = f or ifcopenshell.file(schema="IFC4")
    project = api("root.create_entity", f, ifc_class="IfcProject", name="REF")
    # NB: the API default is MILLIMETRE; Teldra's canonical IFC is metre-based (ADR 0005).
    api("unit.assign_unit", f, length={"is_metric": True, "raw": "METERS"})
    model = api("context.add_context", f, context_type="Model")
    body = api("context.add_context", f, context_type="Model", context_identifier="Body",
               target_view="MODEL_VIEW", parent=model)
    plan = api("context.add_context", f, context_type="Plan")
    axis_ctx = api("context.add_context", f, context_type="Plan", context_identifier="Axis",
                   target_view="GRAPH_VIEW", parent=plan)
    site = api("root.create_entity", f, ifc_class="IfcSite", name="Site")
    bldg = api("root.create_entity", f, ifc_class="IfcBuilding", name="B")
    storey = api("root.create_entity", f, ifc_class="IfcBuildingStorey", name="L0")
    api("aggregate.assign_object", f, products=[site], relating_object=project)
    api("aggregate.assign_object", f, products=[bldg], relating_object=site)
    api("aggregate.assign_object", f, products=[storey], relating_object=bldg)
    return f, storey, body, axis_ctx


def make_wall(f, storey, body, axis_ctx, name, p1, p2, thickness=0.2, height=2.6, layerset=None):
    wall = api("root.create_entity", f, ifc_class="IfcWall", name=name)
    api("spatial.assign_container", f, products=[wall], relating_structure=storey)
    api("geometry.edit_object_placement", f, product=wall, matrix=np.eye(4))
    # Teldra's convention (ADR 0023): axis = local X, body = rectangle (0,0)-(L,t) extruded.
    rep = api("geometry.create_2pt_wall", f, element=wall, context=body, p1=p1, p2=p2,
              elevation=0.0, height=height, thickness=thickness, is_si=True)
    api("geometry.assign_representation", f, product=wall, representation=rep)
    return wall


def make_layered_wall(f, storey, body, axis_ctx, name, p1, p2, thickness=0.2, height=2.6):
    """Bonsai-style wall: Axis rep + material layer set usage; mitring needs both."""
    import math

    L = math.dist(p1, p2)
    ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    wall = api("root.create_entity", f, ifc_class="IfcWall", name=name)
    api("spatial.assign_container", f, products=[wall], relating_structure=storey)
    m = np.eye(4)
    m[:2, :2] = [[math.cos(ang), -math.sin(ang)], [math.sin(ang), math.cos(ang)]]
    m[:2, 3] = p1
    api("geometry.edit_object_placement", f, product=wall, matrix=m)
    axis = api("geometry.add_axis_representation", f, context=axis_ctx, axis=[(0.0, 0.0), (L, 0.0)])
    api("geometry.assign_representation", f, product=wall, representation=axis)
    ls = api("material.add_material_set", f, name=f"{int(thickness*1000)}mm", set_type="IfcMaterialLayerSet")
    mat = api("material.add_material", f, name="Brick")
    layer = api("material.add_layer", f, layer_set=ls, material=mat)
    api("material.edit_layer", f, layer=layer, attributes={"LayerThickness": thickness})
    api("material.assign_material", f, products=[wall], type="IfcMaterialLayerSetUsage", material=ls)
    usage = ifcopenshell.util.element.get_material(wall)
    usage.OffsetFromReferenceLine = -thickness / 2  # centre-line walls, like a CAD plan
    api("geometry.regenerate_wall_representation", f, wall=wall, length=L, height=height)
    return wall


def mitre_scenario():
    f, storey, body, axis_ctx = build()
    P = [(0, 0), (5, 0), (5, 4), (0, 4)]
    ws = [make_layered_wall(f, storey, body, axis_ctx, n, P[i], P[(i + 1) % 4])
          for i, n in enumerate("SENW")]
    before = {w.Name: shape_of(f, w) for w in ws}
    with timed("mitre_connect_path"):
        for i in range(4):
            api("geometry.connect_path", f, relating_element=ws[i], related_element=ws[(i + 1) % 4],
                relating_connection="ATEND", related_connection="ATSTART")
    R["steps"]["mitre_connect_path"]["after_connect_only"] = {w.Name: shape_of(f, w) for w in ws}
    with timed("mitre_regenerate"):
        for w, L in zip(ws, (5, 4, 5, 4), strict=True):
            api("geometry.regenerate_wall_representation", f, wall=w, length=L, height=2.6)
    after = {w.Name: shape_of(f, w) for w in ws}
    R["steps"]["mitre_connect_path"]["before"] = before
    R["steps"]["mitre_connect_path"]["after"] = after
    R["steps"]["mitre_connect_path"]["rels"] = len(f.by_type("IfcRelConnectsPathElements"))
    # T-junction (ATPATH): extra wall starting mid-S wall
    mid = make_layered_wall(f, storey, body, axis_ctx, "T", (2.5, 0.1), (2.5, 2.5))
    with timed("mitre_t_junction"):
        api("geometry.connect_path", f, relating_element=ws[0], related_element=mid,
            relating_connection="ATPATH", related_connection="ATSTART")
    R["steps"]["mitre_t_junction"]["T_after"] = shape_of(f, mid)
    R["steps"]["mitre_t_junction"]["S_after"] = shape_of(f, ws[0])
    # move shared corner (5,0) -> (6,0): regenerate S and E axes, keep connections
    import math

    def set_axis(w, p1, p2):
        L = math.dist(p1, p2)
        ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
        m = np.eye(4)
        m[:2, :2] = [[math.cos(ang), -math.sin(ang)], [math.sin(ang), math.cos(ang)]]
        m[:2, 3] = p1
        api("geometry.edit_object_placement", f, product=w, matrix=m)
        axis = [r for r in w.Representation.Representations if r.RepresentationIdentifier == "Axis"][0]
        api("geometry.unassign_representation", f, product=w, representation=axis)
        api("geometry.remove_representation", f, representation=axis)
        axis = api("geometry.add_axis_representation", f, context=axis_ctx, axis=[(0.0, 0.0), (L, 0.0)])
        api("geometry.assign_representation", f, product=w, representation=axis)
        return L

    with timed("mitre_move_corner"):
        # naive: update + regenerate one wall at a time (order-dependent, leaves stale neighbour)
        lens = {}
        lens["S"] = set_axis(ws[0], (0, 0), (6, 0))
        api("geometry.regenerate_wall_representation", f, wall=ws[0], length=lens["S"], height=2.6)
        lens["E"] = set_axis(ws[1], (6, 0), (5, 4))
        api("geometry.regenerate_wall_representation", f, wall=ws[1], length=lens["E"], height=2.6)
        R["steps"]["mitre_move_corner"]["naive_order"] = {w.Name: shape_of(f, w) for w in ws}
        # correct: second pass over every connected wall
        for w, L in zip(ws, (lens["S"], lens["E"], 5, 4), strict=True):
            api("geometry.regenerate_wall_representation", f, wall=w, length=L, height=2.6)
    R["steps"]["mitre_move_corner"]["data"] = {w.Name: shape_of(f, w) for w in ws}
    R["steps"]["mitre_move_corner"]["rels_preserved"] = len(f.by_type("IfcRelConnectsPathElements"))
    return f


def room_polygon(walls_axes, t):
    """Inner room polygon from axis lines offset by half thickness (rect room only)."""
    xs = [p[0] for a in walls_axes for p in a]
    ys = [p[1] for a in walls_axes for p in a]
    return (min(xs) + t / 2, min(ys) + t / 2, max(xs) - t / 2, max(ys) - t / 2)


def run(out_path: str | None = None):
    with timed("build_model"):
        f, storey, body, axis_ctx = build()
        P = [(0, 0), (5, 0), (5, 4), (0, 4)]
        names = ["S", "E", "N", "W"]
        walls = [make_wall(f, storey, body, axis_ctx, n, P[i], P[(i + 1) % 4])
                 for i, n in enumerate(names)]
    guids0 = {w.Name: w.GlobalId for w in walls}
    R["wall_guids_stable_start"] = guids0

    with timed("geom_walls_initial"):
        R["steps"]["geom_walls_initial"]["data"] = {w.Name: shape_of(f, w) for w in walls}

    # ---- connections via the public API (connect_path regenerates mitred bodies when the
    # wall has an Axis representation + layerset; here we record what happens without/with)
    conn_err = None
    try:
        with timed("connect_path_plain"):
            rel = api("geometry.connect_path", f, relating_element=walls[0], related_element=walls[1],
                      relating_connection="ATEND", related_connection="ATSTART")
        R["steps"]["connect_path_plain"]["rel"] = rel.is_a() if rel else None
    except Exception as e:  # noqa: BLE001
        conn_err = f"{type(e).__name__}: {e}"
    R["steps"]["connect_path_plain"]["error"] = conn_err

    # ---- door + void + filling
    with timed("opening_add"):
        door = api("root.create_entity", f, ifc_class="IfcDoor", name="D1")
        api("spatial.assign_container", f, products=[door], relating_structure=storey)
        opening = api("root.create_entity", f, ifc_class="IfcOpeningElement", name="D1 opening")
        sb = ifcopenshell.util.shape_builder.ShapeBuilder(f)
        # opening box 0.9 x 0.3 (through wall) x 2.1, wall-local placement at x=1.5
        profile = sb.rectangle(size=(0.9, 0.3))
        extr = sb.extrude(profile, 2.1)
        rep = f.createIfcShapeRepresentation(body, "Body", "SweptSolid", [extr])
        api("geometry.assign_representation", f, product=opening, representation=rep)
        m = np.eye(4)
        m[:3, 3] = (1.5, -0.05, 0.0)  # inside host wall S (axis along +X at y=0)
        api("geometry.edit_object_placement", f, product=opening, matrix=m)
        api("feature.add_feature", f, feature=opening, element=walls[0])
        api("geometry.edit_object_placement", f, product=door, matrix=m)
        api("feature.add_filling", f, opening=opening, element=door)
    R["steps"]["opening_add"]["voids"] = [r.is_a() for r in f.by_type("IfcRelVoidsElement")]
    R["steps"]["opening_add"]["fills"] = [r.is_a() for r in f.by_type("IfcRelFillsElement")]

    with timed("geom_wall_with_opening"):
        vol_open, bb = shape_of(f, walls[0])
        R["steps"]["geom_wall_with_opening"]["data"] = {"volume": vol_open}
    vol_plain = R["steps"]["geom_walls_initial"]["data"]["S"][0]
    R["opening_cut_volume_m3"] = round(vol_plain - vol_open, 4)  # expect 0.9*0.2*2.1 = 0.378

    # ---- re-host opening S -> N (remove void rel from S, add to N), keep GlobalIds
    guid_open, guid_door = opening.GlobalId, door.GlobalId
    with timed("rehost_opening"):
        rel = f.by_type("IfcRelVoidsElement")[0]
        f.remove(rel)  # the API has no 'unassign'; remove_feature would delete the opening
        api("feature.add_feature", f, feature=opening, element=walls[2])
        m2 = np.eye(4)
        m2[:3, 3] = (2.0, 4 - 0.15, 0.0)
        api("geometry.edit_object_placement", f, product=opening, matrix=m2)
        api("geometry.edit_object_placement", f, product=door, matrix=m2)
    R["steps"]["rehost_opening"]["guids_stable"] = (opening.GlobalId == guid_open and door.GlobalId == guid_door)
    R["steps"]["rehost_opening"]["volume_S_after"] = shape_of(f, walls[0])[0]
    R["steps"]["rehost_opening"]["volume_N_before_after"] = [
        R["steps"]["geom_walls_initial"]["data"]["N"][0], shape_of(f, walls[2])[0]]

    # ---- move wall E endpoint (5,0)->(6,0) i.e. S end and E start, regenerate bodies
    with timed("move_corner_regen"):
        for wall, p1, p2 in ((walls[0], (0, 0), (6, 0)), (walls[1], (6, 0), (5, 4))):
            if wall.Representation:
                for r in list(wall.Representation.Representations):
                    api("geometry.unassign_representation", f, product=wall, representation=r)
                    api("geometry.remove_representation", f, representation=r)
            rep = api("geometry.create_2pt_wall", f, element=wall, context=body, p1=p1, p2=p2,
                      elevation=0.0, height=2.6, thickness=0.2, is_si=True)
            api("geometry.assign_representation", f, product=wall, representation=rep)
    R["steps"]["move_corner_regen"]["data"] = {w.Name: shape_of(f, w) for w in walls}
    R["wall_guids_stable_end"] = {w.Name: w.GlobalId for w in walls} == guids0

    # ---- space footprint recompute (shapely-free rect room) + validation
    with timed("space_recompute"):
        # Axes now: S (0,0)-(6,0), E (6,0)-(5,4)(skewed!), N (5,4)-(0,4), W (0,4)-(0,0)
        space = api("root.create_entity", f, ifc_class="IfcSpace", name="Room")
        api("aggregate.assign_object", f, products=[space], relating_object=storey)
        x0, y0, x1, y1 = room_polygon([((0, 0), (6, 0)), ((6, 0), (5, 4)), ((5, 4), (0, 4)),
                                      ((0, 4), (0, 0))], 0.2)
        # recompute boundary from the actual axes: conservative bounding rectangle inside walls
        R["steps"]["space_recompute"]["inner_rect"] = [round(v, 3) for v in (x0, y0, x1, y1)]
    # IfcRelSpaceBoundary: one 2nd-level boundary against wall S
    with timed("space_boundary"):
        rsb = f.createIfcRelSpaceBoundary(
            ifcopenshell.guid.new(), None, None, None, space, walls[0], None, "PHYSICAL", "INTERNAL")
        R["steps"]["space_boundary"]["created"] = rsb.is_a()

    with timed("validate"):
        class L:
            def __init__(self):
                self.issues = []

            def error(self, msg, **kw):
                self.issues.append(str(msg)[:200])

            def warning(self, *a, **k):
                pass

            def info(self, *a, **k):
                pass

            def debug(self, *a, **k):
                pass

            def log(self, *a, **k):
                pass

        lg = L()
        ifcopenshell.validate.validate(f, lg, express_rules=True)
        R["steps"]["validate"]["issues"] = lg.issues[:10]
        R["steps"]["validate"]["issue_count"] = len(lg.issues)
    try:
        mf = mitre_scenario()
        lg2 = L()
        ifcopenshell.validate.validate(mf, lg2, express_rules=True)
        R["steps"]["mitre_connect_path"]["validate_issues"] = lg2.issues[:5]
        R["steps"]["mitre_connect_path"]["validate_count"] = len(lg2.issues)
        if out_path:
            mf.write(out_path.replace(".ifc", "-mitre.ifc"))
    except Exception as e:  # noqa: BLE001
        import traceback

        R["mitre_error"] = traceback.format_exc()[-1500:]
    if out_path:
        f.write(out_path)
        R["written"] = out_path
    R["bytes"] = len(f.to_string())
    return R


if __name__ == "__main__":
    print("RESULT", json.dumps(run(sys.argv[1] if len(sys.argv) > 1 else None)))
