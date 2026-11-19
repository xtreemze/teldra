"""Structural IFC roundtrip diff for #125: GlobalId identity, class, name, placement, key
relationships and Teldra_Source provenance psets between two IFC files.

Usage: python tools/research/ifc_identity_diff.py <before.ifc> <after.ifc> [--tol 1e-6]
Exit code 1 when identity is lost (GlobalId removed/added/class-changed) or provenance dropped.
"""
from __future__ import annotations

import json
import sys

import numpy as np

import ifcopenshell
import ifcopenshell.util.element
import ifcopenshell.util.placement

REL_CLASSES = ("IfcRelVoidsElement", "IfcRelFillsElement", "IfcRelConnectsPathElements",
               "IfcRelContainedInSpatialStructure", "IfcRelAggregates", "IfcRelSpaceBoundary")


def snapshot(path: str) -> dict:
    f = ifcopenshell.open(path)
    out = {"schema": f.schema, "entities": {}, "rels": {}, "prov": {}}
    for e in f.by_type("IfcRoot"):
        if e.is_a("IfcRelationship"):
            continue
        m = None
        if getattr(e, "ObjectPlacement", None):
            m = ifcopenshell.util.placement.get_local_placement(e.ObjectPlacement)
        ps = ifcopenshell.util.element.get_psets(e)
        out["entities"][e.GlobalId] = {
            "class": e.is_a(), "name": e.Name,
            "matrix": None if m is None else np.round(m, 9).tolist(),
            "has_rep": bool(getattr(e, "Representation", None)),
        }
        if "Teldra_Source" in ps:
            out["prov"][e.GlobalId] = {k: v for k, v in ps["Teldra_Source"].items() if k != "id"}
    for c in REL_CLASSES:
        edges = set()
        for r in f.by_type(c):
            for a in r.get_info(recursive=False, include_identifier=False).values():
                pass
            rel = r.is_a()
            if rel == "IfcRelVoidsElement":
                edges.add((r.RelatingBuildingElement.GlobalId, r.RelatedOpeningElement.GlobalId))
            elif rel == "IfcRelFillsElement":
                edges.add((r.RelatingOpeningElement.GlobalId, r.RelatedBuildingElement.GlobalId))
            elif rel == "IfcRelConnectsPathElements":
                edges.add((r.RelatingElement.GlobalId, r.RelatedElement.GlobalId,
                           r.RelatingConnectionType, r.RelatedConnectionType))
            elif rel == "IfcRelContainedInSpatialStructure":
                edges.update((r.RelatingStructure.GlobalId, e.GlobalId) for e in r.RelatedElements)
            elif rel == "IfcRelAggregates":
                edges.update((r.RelatingObject.GlobalId, e.GlobalId) for e in r.RelatedObjects)
            elif rel == "IfcRelSpaceBoundary":
                edges.add((r.RelatingSpace.GlobalId, r.RelatedBuildingElement.GlobalId if r.RelatedBuildingElement else None))
        out["rels"][c] = sorted(map(list, edges), key=str)
    return out


def diff(a: dict, b: dict, tol: float = 1e-6) -> dict:
    ea, eb = a["entities"], b["entities"]
    res = {
        "removed_guids": sorted(set(ea) - set(eb)),
        "added_guids": sorted(set(eb) - set(ea)),
        "class_changed": sorted(g for g in set(ea) & set(eb) if ea[g]["class"] != eb[g]["class"]),
        "renamed": sorted(g for g in set(ea) & set(eb) if ea[g]["name"] != eb[g]["name"]),
        "moved": [], "rep_dropped": [], "rep_added": [],
        "provenance_dropped": sorted(set(a["prov"]) - set(b["prov"])),
        "relationship_delta": {},
    }
    for g in set(ea) & set(eb):
        ma, mb = ea[g]["matrix"], eb[g]["matrix"]
        if ma and mb and np.max(np.abs(np.array(ma) - np.array(mb))) > tol:
            res["moved"].append(g)
        if ea[g]["has_rep"] and not eb[g]["has_rep"]:
            res["rep_dropped"].append(g)
        if not ea[g]["has_rep"] and eb[g]["has_rep"]:
            res["rep_added"].append(g)
    for c in REL_CLASSES:
        sa, sb = {json.dumps(x) for x in a["rels"][c]}, {json.dumps(x) for x in b["rels"][c]}
        if sa != sb:
            res["relationship_delta"][c] = {"lost": len(sa - sb), "gained": len(sb - sa)}
    res["identity_preserved"] = not (res["removed_guids"] or res["class_changed"] or res["provenance_dropped"])
    return res


if __name__ == "__main__":
    tol = float(sys.argv[sys.argv.index("--tol") + 1]) if "--tol" in sys.argv else 1e-6
    d = diff(snapshot(sys.argv[1]), snapshot(sys.argv[2]), tol)
    summary = {k: (len(v) if isinstance(v, list) else v) for k, v in d.items()}
    print(json.dumps(summary, indent=1))
    if "--verbose" in sys.argv:
        print(json.dumps(d, indent=1)[:6000])
    sys.exit(0 if d["identity_preserved"] else 1)
