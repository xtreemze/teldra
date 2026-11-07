"""Audit the published 21D demo's actual room materials without rewriting it.

Run on CI's LFS checkout: python3 tools/diagnostics/audit_21d_floor.py
The report diagnoses source color factors, texture bindings, UV completeness and
normals; it does not assume darkness comes from lighting.
"""
from __future__ import annotations

import io
import json
import math
import struct
from collections import Counter
from pathlib import Path
from zipfile import ZipFile

from PIL import Image, ImageStat

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "examples/21d-sweethome3d/21D-demo.teldra"
MAX_ROWS = 60


def read_glb():
    with ZipFile(PROJECT) as package:
        glb = package.read("building.glb")
    if glb[:4] != b"glTF" or len(glb) < 28:
        raise ValueError("Invalid 21D GLB.")
    json_length, json_type = struct.unpack_from("<II", glb, 12)
    if json_type != 0x4E4F534A:
        raise ValueError("Invalid glTF JSON chunk.")
    doc = json.loads(glb[20 : 20 + json_length])
    bin_start = 20 + json_length
    bin_length, bin_type = struct.unpack_from("<II", glb, bin_start)
    if bin_type != 0x004E4942:
        raise ValueError("Invalid glTF BIN chunk.")
    return doc, memoryview(glb)[bin_start + 8 : bin_start + 8 + bin_length]


def accessor_range(doc, binary, index, components, sample_limit=8192):
    accessor = doc["accessors"][index]
    if accessor.get("componentType") != 5126 or accessor.get("type") != ("VEC2" if components == 2 else "VEC3"):
        return None
    view = doc["bufferViews"][accessor["bufferView"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride", 4 * components)
    count = accessor["count"]
    samples = min(count, sample_limit)
    low, high, totals = [math.inf] * components, [-math.inf] * components, [0.0] * components
    for i in range(samples):
        vector = struct.unpack_from("<" + "f" * components, binary, start + stride * i)
        for j, value in enumerate(vector):
            low[j], high[j] = min(low[j], value), max(high[j], value)
            totals[j] += value
    if not samples:
        return None
    return {"span": [round(high[j] - low[j], 4) for j in range(components)],
            "mean": [round(totals[j] / samples, 3) for j in range(components)],
            "count": count, "samples": samples}


def audit():
    doc, binary = read_glb()
    rows = []
    counts = Counter()
    room_texture_indices = set()
    materials = doc.get("materials", [])
    for node in doc.get("nodes", []):
        identity = node.get("extras", {}).get("teldra", {})
        canonical_id = identity.get("canonicalId", "")
        if not (canonical_id.startswith("sh3d:room:") or canonical_id.startswith("room:")):
            continue
        counts["roomNodes"] += 1
        if "mesh" not in node:
            continue
        for primitive in doc["meshes"][node["mesh"]]["primitives"]:
            if primitive.get("mode", 4) != 4:
                continue
            counts["roomTriangleParts"] += 1
            material = materials[primitive["material"]]
            pbr = material.get("pbrMetallicRoughness", {})
            source = material.get("extras", {}).get("teldraSourceMaterial", {})
            texture_index = pbr.get("baseColorTexture", {}).get("index")
            has_texture = texture_index is not None
            kd = source.get("Kd", pbr.get("baseColorFactor", [0.8, 0.8, 0.8])[:3])
            attributes = primitive["attributes"]
            uv = (accessor_range(doc, binary, attributes["TEXCOORD_0"], 2)
                  if "TEXCOORD_0" in attributes else None)
            normal = (accessor_range(doc, binary, attributes["NORMAL"], 3)
                      if "NORMAL" in attributes else None)
            black_kd = max(kd) <= 0.015
            flat_uv = uv is not None and max(uv["span"]) <= 0.0001
            if has_texture:
                room_texture_indices.add(texture_index)
                counts["texturedRoomParts"] += 1
            if not has_texture:
                counts["untexturedRoomParts"] += 1
            if has_texture and uv is None:
                counts["texturedWithoutUv"] += 1
            if has_texture and flat_uv:
                counts["texturedFlatUv"] += 1
            if black_kd:
                counts["nearBlackKd"] += 1
            if has_texture and black_kd:
                counts["texturedNearBlackKd"] += 1
            if normal is None:
                counts["missingNormal"] += 1
            # Emit a bounded, distinct-material/geometry sample for real floor diagnosis.
            rows.append({
                "material": material.get("name", ""),
                "materialIndex": primitive["material"],
                "Kd": kd,
                "Ka": source.get("Ka"),
                "map_Kd": source.get("map_Kd"),
                "textureIndex": texture_index,
                "uvSpan": uv["span"] if uv else None,
                "normalY": normal["mean"][1] if normal else None,
                "vertexCount": doc["accessors"][attributes["POSITION"]]["count"],
                "suspect": bool(has_texture and (black_kd or flat_uv or uv is None)),
            })
    samples = []
    seen = set()
    for row in sorted(rows, key=lambda r: (not r["suspect"], r["materialIndex"])):
        signature = (row["materialIndex"], tuple(row["uvSpan"] or []),
                     round(row["normalY"] or 0.0, 1))
        if signature in seen:
            continue
        seen.add(signature)
        samples.append(row)
        if len(samples) == MAX_ROWS:
            break
    # Decode the embedded textures, not source images from the repository.
    # This distinguishes a dark source bitmap from a runtime texture binding bug.
    texture_stats = []
    for index in sorted(room_texture_indices):
        record = doc["textures"][index]
        image = doc["images"][record["source"]]
        view = doc["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        payload = bytes(binary[start : start + view["byteLength"]])
        with Image.open(io.BytesIO(payload)) as original:
            image_rgb = original.convert("RGB")
            preview = image_rgb.copy()
            preview.thumbnail((128, 128), Image.Resampling.BILINEAR)
            stat = ImageStat.Stat(preview)
            pixels = list(preview.getdata())
            texture_stats.append({
                "textureIndex": index,
                "imageName": image.get("name"),
                "size": original.size,
                "meanRGB": [round(v, 1) for v in stat.mean],
                "rangeRGB": preview.getextrema(),
                "nearBlackFraction": round(
                    sum(max(pixel) < 16 for pixel in pixels) / len(pixels), 4
                ),
                "centerPixel": preview.getpixel((preview.width // 2, preview.height // 2)),
            })
    print(json.dumps({
        "asset": "published 21D demo",
        "totalMaterials": len(materials),
        "totalEmbeddedImages": len(doc.get("images", [])),
        "counts": dict(counts),
        "roomTextureStats": texture_stats,
        "roomSamples": samples,
        "truncated": len(rows) > len(samples),
    }, indent=2))


if __name__ == "__main__":
    audit()
