"""Audit an IFC file with IfcOpenShell: class/relationship inventory, open/iterate/validate timings,
wall-edit eligibility signals (voids, path connections, space boundaries, rep types).

Usage: python tools/research/ifc_fixture_audit.py <model.ifc> [--validate] [--geom]
"""
from __future__ import annotations

import collections
import json
import multiprocessing
import sys
import time

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.validate

path = sys.argv[1]
out: dict = {"file": path, "ifcopenshell": ifcopenshell.version}
t = time.perf_counter()
f = ifcopenshell.open(path)
out["open_ms"] = round((time.perf_counter() - t) * 1000)
out["schema"] = f.schema
out["entities"] = sum(1 for _ in f)
cls = collections.Counter(e.is_a() for e in f)
out["products"] = {k: v for k, v in cls.most_common() if k.startswith(("IfcWall", "IfcSlab", "IfcSpace", "IfcDoor", "IfcWindow", "IfcOpening", "IfcFurnish", "IfcLight", "IfcBuildingElementProxy", "IfcBuildingStorey", "IfcCovering", "IfcRoof", "IfcColumn"))}
out["relationships"] = {k: v for k, v in cls.items() if k.startswith("IfcRel")}
walls = f.by_type("IfcWall")
out["wall_rep_types"] = dict(collections.Counter(
    tuple(sorted({r.RepresentationType for r in (w.Representation.Representations if w.Representation else [])}))
    for w in walls
).most_common(5)) if False else {
    str(k): v for k, v in collections.Counter(
        tuple(sorted({str(r.RepresentationType) for r in (w.Representation.Representations if w.Representation else [])}))
        for w in walls).items()}
out["walls_with_voids"] = sum(1 for w in walls if getattr(w, "HasOpenings", ()))
out["walls_with_path_connections"] = sum(
    1 for w in walls if getattr(w, "ConnectedTo", ()) or getattr(w, "ConnectedFrom", ()))
out["walls_with_material"] = sum(1 for w in walls if ifcopenshell.util.element.get_material(w))
if "--geom" in sys.argv:
    s = ifcopenshell.geom.settings()
    t = time.perf_counter()
    it = ifcopenshell.geom.iterator(s, f, multiprocessing.cpu_count())
    n = tris = 0
    if it.initialize():
        while True:
            sh = it.get()
            n += 1
            tris += len(sh.geometry.faces) // 3
            if not it.next():
                break
    out["geom_iterate"] = {"ms": round((time.perf_counter() - t) * 1000), "elements": n, "triangles": tris,
                           "threads": multiprocessing.cpu_count()}
if "--validate" in sys.argv:
    class L:
        n = 0
        kinds: collections.Counter = collections.Counter()

        def error(self, msg="", *a, **k):
            L.n += 1
            L.kinds[str(msg)[:80]] += 1

        warning = info = debug = log = lambda self, *a, **k: None

    t = time.perf_counter()
    ifcopenshell.validate.validate(f, L(), express_rules=False)
    out["validate"] = {"ms": round((time.perf_counter() - t) * 1000), "errors": L.n,
                       "top": L.kinds.most_common(4)}
print(json.dumps(out, indent=1))
