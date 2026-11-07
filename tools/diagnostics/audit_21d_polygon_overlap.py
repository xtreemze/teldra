"""Read-only polygon-level overlap test for the real 21D building GLB.

The earlier bounding-box report identified near-coplanar candidates but could
not determine whether the polygons actually overlap. This samples interior
points in every textured SH3D room triangle and checks the true 2D triangles
of other visible nearly-horizontal surfaces at that location. Hidden source
parts are excluded. CI output is a diagnostic, NOT a rendered-pixel test.

Run: python3 tools/diagnostics/audit_21d_polygon_overlap.py
"""
from __future__ import annotations

import json
import math
import struct
from collections import Counter, defaultdict
from pathlib import Path
from zipfile import ZipFile

ARCHIVE = Path(__file__).resolve().parents[2] / "examples/21d-sweethome3d/21D-demo.teldra"
EPSILON_Y = 0.002  # 2 mm, source converted from centimetres
BARYCENTRIC_SAMPLES = ((0.333, 0.333, 0.334), (0.1, 0.2, 0.7), (0.65, 0.25, 0.10))


def glb() -> tuple[dict, memoryview]:
    with ZipFile(ARCHIVE) as z:
        payload = z.read("building.glb")
    if payload[:4] != b"glTF":
        raise ValueError("Missing GLB magic")
    json_size, json_type = struct.unpack_from("<II", payload, 12)
    if json_type != 0x4E4F534A:
        raise ValueError("GLB JSON chunk missing")
    doc = json.loads(payload[20:20+json_size])
    binary_at = 20 + json_size
    binary_size, binary_type = struct.unpack_from("<II", payload, binary_at)
    if binary_type != 0x004E4942:
        raise ValueError("GLB binary chunk missing")
    return doc, memoryview(payload)[binary_at+8:binary_at+8+binary_size]


def attribute(doc: dict, raw: memoryview, index: int) -> list[tuple]:
    entry = doc["accessors"][index]
    fmt = {(5126, "VEC3"): "fff", (5125, "SCALAR"): "I",
           (5123, "SCALAR"): "H"}.get((entry["componentType"], entry["type"]))
    if fmt is None:
        raise ValueError(f"Unsupported geometry accessor: {entry}")
    view = doc["bufferViews"][entry["bufferView"]]
    start = view.get("byteOffset", 0) + entry.get("byteOffset", 0)
    size = struct.calcsize("<" + fmt)
    stride = view.get("byteStride", size)
    unpack = struct.Struct("<" + fmt).unpack_from
    return [unpack(raw, start + i*stride) for i in range(entry["count"])]


def point_inside(x: float, z: float, points: tuple) -> bool:
    ax, az = points[0][0], points[0][2]
    bx, bz = points[1][0], points[1][2]
    cx, cz = points[2][0], points[2][2]
    den = (bz-cz)*(ax-cx)+(cx-bx)*(az-cz)
    if abs(den) < 1e-12:
        return False
    u = ((bz-cz)*(x-cx)+(cx-bx)*(z-cz))/den
    v = ((cz-az)*(x-cx)+(ax-cx)*(z-cz))/den
    w = 1-u-v
    return min(u, v, w) >= -1e-6


def measure() -> dict:
    doc, binary = glb()
    planes = []
    floors = []
    for node in doc["nodes"]:
        if "mesh" not in node:
            continue
        metadata = node.get("extras", {})
        identity = metadata.get("teldra", {}).get("canonicalId", "presentation:unknown")
        if metadata.get("teldraSourceVisibility", {}).get("hidden") is True:
            continue
        for primitive in doc["meshes"][node["mesh"]]["primitives"]:
            if primitive.get("mode", 4) != 4:
                continue
            bounds = doc["accessors"][primitive["attributes"]["POSITION"]]
            low, high = bounds.get("min"), bounds.get("max")
            if not low or not high or high[1] - low[1] > 0.002:
                continue
            material = doc["materials"][primitive["material"]]
            textured = "baseColorTexture" in material.get("pbrMetallicRoughness", {})
            is_floor = identity.startswith(("sh3d:room:", "room:")) and textured
            points = attribute(doc, binary, primitive["attributes"]["POSITION"])
            indices = [item[0] for item in attribute(doc, binary, primitive["indices"])]
            triangles = []
            for i in range(0, len(indices), 3):
                if i+2 >= len(indices):
                    break
                a, b, c = (points[indices[i+j]] for j in range(3))
                if max(abs(a[1]-b[1]), abs(a[1]-c[1])) > EPSILON_Y:
                    continue
                bbox = (min(a[0], b[0], c[0]), max(a[0], b[0], c[0]),
                        min(a[2], b[2], c[2]), max(a[2], b[2], c[2]))
                triangles.append(((a, b, c), bbox))
            if not triangles:
                continue
            row = {"id": identity, "name": node.get("name", ""),
                   "material": material.get("name", ""), "textured": textured,
                   "y": (low[1]+high[1])/2, "bbox": (low[0], high[0], low[2], high[2]),
                   "triangles": triangles, "floor": is_floor}
            planes.append(row)
            if is_floor:
                floors.append(row)
    hits = defaultdict(Counter)
    sampled = Counter()
    for floor in floors:
        key = floor["id"]
        for vertices, _bbox in floor["triangles"]:
            for weights in BARYCENTRIC_SAMPLES:
                x = sum(weights[i] * vertices[i][0] for i in range(3))
                z = sum(weights[i] * vertices[i][2] for i in range(3))
                y = sum(weights[i] * vertices[i][1] for i in range(3))
                sampled[key] += 1
                contenders = set()
                for other in planes:
                    if other is floor or abs(other["y"]-y) > EPSILON_Y:
                        continue
                    a,b,c,d=other["bbox"]
                    if not (a-1e-6 <= x <= b+1e-6 and c-1e-6 <= z <= d+1e-6):
                        continue
                    if any(rect[0]-1e-6 <= x <= rect[1]+1e-6 and
                           rect[2]-1e-6 <= z <= rect[3]+1e-6 and
                           point_inside(x,z,triangle)
                           for triangle,rect in other["triangles"]):
                        contenders.add((other["id"], other["material"][:65]))
                for other_id, other_material in contenders:
                    hits[key][(other_id,other_material)] += 1
    details = []
    for key, total in sampled.items():
        details.append({"floor":key,"testedInteriorPoints":total,
                        "otherSurfaceCoverages":[
                           {"canonicalId":name,"material":mat,
                            "coveredPoints":count,"fraction":round(count/total,3)}
                           for (name,mat),count in hits[key].most_common(12)]})
    return {"floorParts":len(floors),"horizontalParts":len(planes),
            "sampledFloorPoints":sum(sampled.values()),
            "floorPartsWithCoveredInterior":sum(bool(hits[f]) for f in sampled),
            "details":details,
            "limitations":"Polygon interior point sampling, not GPU depth/shader proof; actual rendered scene may hide presentation layer. Sampled triangles are local XYZ with identity node transforms."}


if __name__ == "__main__":
    print(json.dumps(measure(), indent=2))
