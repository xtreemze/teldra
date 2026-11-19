"""Cross-check an IFC written by another engine (e.g. the TypeScript web-ifc wall writer)
with IfcOpenShell: schema validation, wall geometry (bbox, volume, voids applied), path
connections. GlobalId-format errors are reported separately from structural errors.

Usage: python tools/research/ifc_crosscheck.py <edited.ifc>
"""
from __future__ import annotations

import json
import sys

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.shape
import ifcopenshell.validate

f = ifcopenshell.open(sys.argv[1])
lg = ifcopenshell.validate.json_logger()
ifcopenshell.validate.validate(f, lg, express_rules=True)
guid_errs = [s for s in lg.statements if "GlobalId" in str(s.get("message"))]
other = [s for s in lg.statements if "GlobalId" not in str(s.get("message"))]
S = ifcopenshell.geom.settings()
S.set("use-world-coords", True)
walls = {}
for w in f.by_type("IfcWall"):
    g = ifcopenshell.geom.create_shape(S, w).geometry
    v = ifcopenshell.util.shape.get_vertices(g)
    walls[w.Name] = {"volume": round(float(ifcopenshell.util.shape.get_volume(g)), 4),
                     "bbox": [round(float(x), 3) for x in (*v.min(0), *v.max(0))]}
print(json.dumps({
    "schema": f.schema, "globalid_format_errors": len(guid_errs), "other_errors": len(other),
    "other_error_samples": [str(s.get("message"))[:240] for s in other[:3]],
    "path_connections": [(r.RelatingElement.Name, r.RelatedElement.Name, r.RelatingConnectionType,
                          r.RelatedConnectionType) for r in f.by_type("IfcRelConnectsPathElements")],
    "walls": walls}, indent=1))
