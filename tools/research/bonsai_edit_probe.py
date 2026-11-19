"""Headless Bonsai probe: load an IFC through Bonsai, list the operators that matter for
wall/opening/space authoring, then try real Bonsai edits (join wall, opening re-host, regenerate)
and write the result for ifcopenshell.validate / GlobalId diffing.

Run (Blender 5.x + Bonsai installed per docs/research/capability-matrix.md):
  blender -b --python tools/research/bonsai_edit_probe.py -- <in.ifc> <out.ifc> [list|load|join]
"""
import sys
import time
import traceback

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = argv[0], argv[1]
mode = argv[2] if len(argv) > 2 else "load"

import bonsai.tool as tool  # noqa: E402
import ifcopenshell  # noqa: E402

print("BP blender", bpy.app.version_string, "bonsai-ifcopenshell", ifcopenshell.version)

if mode == "list":
    names = sorted(n for n in dir(bpy.ops.bim) if any(
        k in n for k in ("wall", "opening", "space", "boundary", "void", "fill", "door", "window",
                         "slab", "mitre", "join", "extend", "roof", "stair", "regen", "georef", "grid")))
    print("BP operators", len(names))
    for n in names:
        print("BP op", n)
    sys.exit(0)

t = time.perf_counter()
bpy.ops.bim.load_project(filepath=src, should_start_fresh_session=True)
print("BP load_ms", round((time.perf_counter() - t) * 1000), "blender_objects", len(bpy.data.objects))
f = tool.Ifc.get()
print("BP schema", f.schema, "walls", len(f.by_type("IfcWall")), "spaces", len(f.by_type("IfcSpace")))

if mode == "join":
    # Exercise Bonsai's own wall operators on a model that has Axis + layerset walls.
    walls = f.by_type("IfcWall")
    objs = [tool.Ifc.get_object(w) for w in walls]
    print("BP wall objects", [o.name if o else None for o in objs][:6])
    guids = {w.GlobalId: w.Name for w in walls}

    def select(*os):
        for o in bpy.context.selected_objects:
            o.select_set(False)
        for o in os:
            o.select_set(True)
        bpy.context.view_layer.objects.active = os[0]

    def attempt(label, fn):
        try:
            t0 = time.perf_counter()
            r = fn()
            print("BP", label, r, "ms", round((time.perf_counter() - t0) * 1000, 1),
                  "path-rels", len(f.by_type("IfcRelConnectsPathElements")))
        except Exception:  # noqa: BLE001
            print("BP", label, "ERROR", traceback.format_exc()[-500:].replace("\n", " | "))

    select(objs[0], objs[1])
    attempt("unjoin_walls", lambda: bpy.ops.bim.unjoin_walls())
    attempt("join_walls_intersection", lambda: bpy.ops.bim.join_walls_intersection())
    select(objs[0])
    attempt("recalculate_wall", lambda: bpy.ops.bim.recalculate_wall())
    select(*objs[:4])
    attempt("generate_spaces_from_walls(4 selected)", lambda: bpy.ops.bim.generate_spaces_from_walls())
    sp = f.by_type("IfcSpace")
    print("BP spaces", [(x.Name, bool(x.Representation)) for x in sp])
    select(*objs[:4])
    attempt("generate_space(roomrect)", lambda: bpy.ops.bim.generate_space())
    attempt("split_wall", lambda: bpy.ops.bim.split_wall())
    print("BP guids stable", all(w.GlobalId in guids for w in f.by_type("IfcWall") if w.GlobalId in guids),
          "wall count", len(f.by_type("IfcWall")), "spaces", len(f.by_type("IfcSpace")))

if mode == "move":
    # Move one wall and one furniture object in Blender, let Bonsai's depsgraph handler sync
    # placements to IFC, then save. Expect exactly those two GlobalIds to change placement.
    wall = f.by_type("IfcWall")[0]
    chair = f.by_type("IfcFurniture")[0]
    for el, d in ((wall, (0.25, 0.0, 0.0)), (chair, (0.0, 0.5, 0.0))):
        o = tool.Ifc.get_object(el)
        o.location.x += d[0]
        o.location.y += d[1]
        print("BP moved", el.is_a(), el.GlobalId, "->", tuple(round(v, 3) for v in o.location))
    bpy.context.view_layer.update()
    # Bonsai flushes pending object transforms to IFC placements inside its save operator.
    r = bpy.ops.bim.save_project(filepath=dst, should_save_as=True)
    print("BP save_project", r)
    sys.exit(0)

f.write(dst)
print("BP wrote", dst)
