"""Inspect coplanar or near-coplanar meshes in the real 21D GLB.

Read-only; run after a Git LFS checkout:
    python3 tools/diagnostics/audit_21d_depth.py

Bounding-box overlaps are *candidates*, not proof of intersecting triangles.
Only node-local geometry with identity transform is compared; the SH3D Wavefront
converter currently writes mesh vertices in global coordinates.
"""
import json
import struct
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]
ASSET = ROOT / "examples/21d-sweethome3d/21D-demo.teldra"


def geometry_bounds():
    with ZipFile(ASSET) as package:
        glb = package.read("building.glb")
    if glb[:4] != b"glTF":
        raise ValueError("Invalid GLB")
    size, kind = struct.unpack_from("<II", glb, 12)
    if kind != 0x4E4F534A:
        raise ValueError("GLB lacks JSON")
    doc = json.loads(glb[20 : 20 + size])
    rows = []
    for node in doc["nodes"]:
        if "mesh" not in node:
            continue
        if "matrix" in node or "translation" in node or "rotation" in node or "scale" in node:
            continue
        identity = node.get("extras", {}).get("teldra", {})
        canonical_id = identity.get("canonicalId", "")
        for primitive in doc["meshes"][node["mesh"]]["primitives"]:
            accessor = doc["accessors"][primitive["attributes"]["POSITION"]]
            lo, hi = accessor.get("min"), accessor.get("max")
            if not lo or not hi or hi[1] - lo[1] > 0.015:
                continue  # ignore non-horizontal 3D parts
            material = doc["materials"][primitive["material"]]
            name = material.get("name", "")
            source = node.get("extras", {})
            rows.append({
                "name": node.get("name", ""),
                "canonicalId": canonical_id,
                "material": name,
                "hidden": source.get("teldraSourceVisibility", {}).get("hidden", False),
                "textured": "baseColorTexture" in material.get("pbrMetallicRoughness", {}),
                "y": (lo[1] + hi[1]) / 2,
                "rect": (lo[0], lo[2], hi[0], hi[2]),
            })
    floors = [r for r in rows if r["canonicalId"].startswith(("sh3d:room:", "room:")) and r["textured"] and not r["hidden"]]
    candidates = []
    for f in floors:
        min_x, min_z, max_x, max_z = f["rect"]
        area = max(0.0001, (max_x-min_x)*(max_z-min_z))
        for other in rows:
            if other is f or other["hidden"]:
                continue
            if abs(other["y"] - f["y"]) > 0.02:
                continue
            l, t, r, b = other["rect"]
            overlap = max(0, min(max_x, r)-max(min_x, l))*max(0, min(max_z, b)-max(min_z,t))
            if overlap/area < 0.015:
                continue
            candidates.append({
                "floor": f["canonicalId"],
                "other": other["canonicalId"],
                "heightDifferenceCm": round(100*(f["y"]-other["y"]),3),
                "overlapBBoxFraction": round(overlap/area,3),
                "otherMaterial": other["material"],
                "otherTextured": other["textured"],
            })
    candidates.sort(key=lambda v: (-v["overlapBBoxFraction"], abs(v["heightDifferenceCm"])))
    print(json.dumps({
        "floors": len(floors),
        "flatSurfaces": len(rows),
        "coincidentOrNearCoplanarBBoxCandidates": len(candidates),
        "examples": candidates[:45],
        "note": "bbox overlaps require polygon-level confirmation; not evidence of visibility defect by themselves",
    }, indent=2))


if __name__ == "__main__":
    geometry_bounds()
