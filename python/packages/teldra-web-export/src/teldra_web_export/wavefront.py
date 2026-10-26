"""Bounded Wavefront transport conversion, retaining source geometry and image bytes."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import math
import re
import struct
from array import array
from collections import Counter
from pathlib import Path

from PIL import Image, ImageCms

from .exporter import CANONICAL_TO_GLTF

MAX_FILE_BYTES = 512 * 1024 * 1024


def _portable_image(payload: bytes) -> tuple[bytes, bool]:
    """Keep ordinary image bytes; color-manage tagged images into glTF's sRGB."""
    with Image.open(io.BytesIO(payload)) as image:
        if image.width * image.height > 64 * 1024**2:
            raise ValueError("Texture exceeds the pixel safety limit.")
        profile = image.info.get("icc_profile")
        if not profile:
            return payload, False
        source_profile = ImageCms.ImageCmsProfile(io.BytesIO(profile))
        rgba = image.convert("RGBA")
        rgb = ImageCms.profileToProfile(
            rgba.convert("RGB"),
            source_profile,
            ImageCms.createProfile("sRGB"),
            outputMode="RGB",
            renderingIntent=0,
        ).convert("RGBA")
        rgb.putalpha(rgba.getchannel("A"))
        # Clear the source display profile; converted texels now have sRGB semantics.
        rgb.info.clear()
        output = io.BytesIO()
        rgb.save(output, format="PNG")
        return output.getvalue(), True


def _local(root: Path, name: str) -> Path:
    path = (root / name).resolve()
    if ":" in name or "\\" in name or not path.is_relative_to(root.resolve()):
        raise ValueError(f"Non-local Wavefront resource: {name}")
    if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"Missing or oversized Wavefront resource: {name}")
    return path


def _numbers(values: list[str]) -> list[float]:
    result = [float(value) for value in values]
    if not all(math.isfinite(value) for value in result):
        raise ValueError("Wavefront values must be finite.")
    return result


def export_wavefront_scene(
    obj_path: Path,
    glb_path: Path,
    manifest_path: Path,
    *,
    building_sha256: str,
    source_bindings: dict[str, tuple[str, str]] | None = None,
) -> dict:
    """SH3D OBJ coordinates are centimetres, right-handed Y-up (X, elevation, Y)."""
    obj_path = obj_path.resolve()
    _local(obj_path.parent, obj_path.name)
    binary = bytearray()
    doc = {
        "asset": {"version": "2.0", "generator": "Teldra SH3D visual transport"},
        "scene": 0,
        "scenes": [{"nodes": []}],
        "nodes": [],
        "meshes": [],
        "materials": [],
        "images": [],
        "textures": [],
        "accessors": [],
        "bufferViews": [],
        "samplers": [{"wrapS": 10497, "wrapT": 10497, "magFilter": 9729, "minFilter": 9987}],
    }
    material_index = {}
    material_variants = {}
    texture_index = {}
    resources = []
    primitive_counts = Counter()
    manifest_nodes = []
    source_keys_with_visuals = set()

    def view(payload: bytes, target: int | None = None) -> int:
        binary.extend(b"\0" * (-len(binary) % 4))
        item = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(payload)}
        if target is not None:
            item["target"] = target
        binary.extend(payload)
        doc["bufferViews"].append(item)
        return len(doc["bufferViews"]) - 1

    def accessor(values: list, size: int, *, indices: bool = False) -> int:
        data = array("I" if indices else "f", values)
        item = {
            "bufferView": view(data.tobytes(), 34963 if indices else 34962),
            "componentType": 5125 if indices else 5126,
            "count": len(values) // size,
            "type": "SCALAR" if size == 1 else f"VEC{size}",
        }
        if size == 3 and not indices:
            item["min"] = [min(values[i::3]) for i in range(3)]
            item["max"] = [max(values[i::3]) for i in range(3)]
        doc["accessors"].append(item)
        return len(doc["accessors"]) - 1

    def texture(name: str) -> tuple[int, bool]:
        if name in texture_index:
            return texture_index[name]
        path = _local(obj_path.parent, name)
        original = path.read_bytes()
        payload, color_converted = _portable_image(original)
        png = payload.startswith(b"\x89PNG\r\n\x1a\n")
        if not png and not payload.startswith(b"\xff\xd8"):
            raise ValueError(f"Unsupported image encoding: {name}")
        image_index = len(doc["images"])
        doc["images"].append(
            {
                "name": name,
                "bufferView": view(payload),
                "mimeType": "image/png" if png else "image/jpeg",
            }
        )
        doc["textures"].append({"source": image_index, "sampler": 0})
        # PNG alpha is retained in full; translucent texels must not be alpha-tested away.
        alpha = False
        if png:
            with Image.open(io.BytesIO(payload)) as image:
                if "A" in image.getbands() or "transparency" in image.info:
                    alpha = image.convert("RGBA").getchannel("A").getextrema()[0] < 255
        result = (len(doc["textures"]) - 1, alpha)
        texture_index[name] = result
        resources.append(
            {
                "path": name,
                "sha256": hashlib.sha256(original).hexdigest(),
                "bytes": len(original),
                "embeddedSha256": hashlib.sha256(payload).hexdigest(),
                "colorConversion": "icc-to-srgb" if color_converted else "none",
            }
        )
        return result

    def add_material(name: str, values: dict) -> None:
        if name in material_index:
            raise ValueError(f"Duplicate Wavefront material: {name}")
        kd = values.get("Kd", [0.8, 0.8, 0.8])
        opacity = values.get("d", [1.0])[0]
        ns = values.get("Ns", [0.0])[0]
        if len(kd) != 3 or not all(0 <= x <= 1 for x in kd) or not 0 <= opacity <= 1 or ns < 0:
            raise ValueError(f"Invalid material values: {name}")
        material = {
            "name": name,
            "doubleSided": False,
            "pbrMetallicRoughness": {
                "baseColorFactor": [*kd, opacity],
                "metallicFactor": 0.0,
                "roughnessFactor": min(1.0, (2.0 / (ns + 2)) ** 0.25),
            },
            "extras": {
                "teldraSourceMaterial": {
                    "format": "wavefront-mtl",
                    "materialKey": name,
                    **values,
                }
            },
        }
        alpha = opacity < 1
        if "map_Kd" in values:
            index, texture_alpha = texture(values["map_Kd"])
            material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": index}
            alpha = alpha or texture_alpha
        material["alphaMode"] = "BLEND" if alpha else "OPAQUE"
        material_index[name] = len(doc["materials"])
        doc["materials"].append(material)

    def load_materials(name: str) -> None:
        path = _local(obj_path.parent, name)
        resources.append(
            {
                "path": name,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "bytes": path.stat().st_size,
            }
        )
        current = None
        values = {}
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            fields = line.split()
            if not fields or fields[0].startswith("#"):
                continue
            key, rest = fields[0], fields[1:]
            if key == "newmtl":
                if current is not None:
                    add_material(current, values)
                current, values = " ".join(rest), {}
            elif current is None:
                raise ValueError("MTL property before newmtl.")
            elif key == "map_Kd":
                value = " ".join(rest)
                if value.startswith("-"):
                    raise ValueError("MTL texture options require an explicit conversion policy.")
                values[key] = value
            elif key in {"Ka", "Kd", "Ks", "Ns", "Ni", "d", "illum", "sharpness"}:
                values[key] = _numbers(rest)
            else:
                raise ValueError(f"Unsupported MTL directive: {key}")
        if current is not None:
            add_material(current, values)

    positions, normals, uvs = [], [], []
    group, material_name = "default", None
    batches = []
    active = None

    def vertex(token: str) -> tuple:
        fields = token.split("/")
        if len(fields) > 3:
            raise ValueError("Invalid OBJ vertex reference.")
        result = []
        for index, pool in enumerate((positions, uvs, normals)):
            value = fields[index] if index < len(fields) else ""
            if not value:
                result.append(None)
                continue
            number = int(value)
            resolved = number - 1 if number > 0 else len(pool) + number
            if number == 0 or not 0 <= resolved < len(pool):
                raise ValueError("OBJ vertex index is out of bounds.")
            result.append(resolved)
        if result[0] is None:
            raise ValueError("OBJ position is required.")
        return tuple(result)

    for line in obj_path.open(encoding="utf-8-sig"):
        fields = line.split()
        if not fields or fields[0].startswith("#"):
            continue
        key, rest = fields[0], fields[1:]
        if key in {"v", "vn", "vt"}:
            values = _numbers(rest)
            size = 2 if key == "vt" else 3
            if key == "vt" and len(values) == 3 and values[2] == 0:
                values = values[:2]
            if len(values) != size:
                raise ValueError(f"Unsupported OBJ {key} component count.")
            {"v": positions, "vn": normals, "vt": uvs}[key].append(values)
        elif key == "mtllib":
            load_materials(" ".join(rest))
        elif key in {"g", "o"}:
            group, active = " ".join(rest), None
        elif key == "usemtl":
            material_name, active = " ".join(rest), None
        elif key in {"f", "l"}:
            mode = 4 if key == "f" else 1
            if active is None or active[2] != mode:
                active = [group, material_name, mode, []]
                batches.append(active)
            refs = [vertex(token) for token in rest]
            if key == "f":
                if len(refs) not in {3, 4}:
                    raise ValueError("Only native-export triangles/convex quads are supported.")
                for index in range(1, len(refs) - 1):
                    active[3].extend((refs[0], refs[index], refs[index + 1]))
                primitive_counts["faces"] += 1
                primitive_counts["triangles"] += len(refs) - 2
            else:
                for index in range(len(refs) - 1):
                    active[3].extend((refs[index], refs[index + 1]))
                primitive_counts["lineSegments"] += len(refs) - 1
        elif key != "s":
            raise ValueError(f"Unsupported OBJ directive: {key}")

    for ordinal, (name, material_name, mode, refs) in enumerate(batches):
        if not refs:
            continue
        if material_name not in material_index:
            raise ValueError(f"Undefined OBJ material: {material_name}")
        lookup, indices, xyz, texcoords, normal_data = {}, [], [], [], []
        textured = bool(
            doc["materials"][material_index[material_name]]["pbrMetallicRoughness"].get(
                "baseColorTexture"
            )
        )
        with_uv = textured or any(ref[1] is not None for ref in refs)
        with_normals = all(ref[2] is not None for ref in refs)
        for ref in refs:
            if ref not in lookup:
                lookup[ref] = len(lookup)
                xyz.extend(value * 0.01 for value in positions[ref[0]])
                if with_uv:
                    # OBJ's unspecified texture coordinate is (0, 0); preserve
                    # that default explicitly rather than dropping the texture.
                    u, v = (0.0, 0.0) if ref[1] is None else uvs[ref[1]]
                    if ref[1] is None:
                        primitive_counts["defaultUvVertices"] += 1
                    texcoords.extend((u, 1.0 - v))
                if with_normals:
                    normal_data.extend(normals[ref[2]])
            indices.append(lookup[ref])
        attributes = {"POSITION": accessor(xyz, 3)}
        if with_uv:
            attributes["TEXCOORD_0"] = accessor(texcoords, 2)
        if with_normals:
            attributes["NORMAL"] = accessor(normal_data, 3)
        material_id = material_index[material_name]
        if "_CullNone_" in name:
            if material_id not in material_variants:
                variant = copy.deepcopy(doc["materials"][material_id])
                variant["doubleSided"] = True
                variant["name"] += ":double-sided"
                material_variants[material_id] = len(doc["materials"])
                doc["materials"].append(variant)
            material_id = material_variants[material_id]
        primitive = {
            "attributes": attributes,
            "indices": accessor(indices, 1, indices=True),
            "material": material_id,
            "mode": mode,
        }
        mesh_index = len(doc["meshes"])
        doc["meshes"].append({"name": name, "primitives": [primitive]})
        node_key = f"sh3d-visual:part:{ordinal}"
        identity = {"nodeKey": node_key, "canonicalId": "presentation:sh3d-visual"}
        matches = [
            key
            for key in (source_bindings or {})
            if any(
                marker + re.sub(r"[^A-Za-z0-9_]", "_", key.split(":", 1)[1]) + "_" in name
                for marker in ("teldraVisible_", "teldraHidden_")
            )
        ]
        if len(matches) > 1:
            raise ValueError(f"Ambiguous native source identity: {name}")
        if matches:
            source_key = matches[0]
            canonical_id, global_id = source_bindings[source_key]
            identity.update(canonicalId=canonical_id, ifcGlobalId=global_id)
            source_keys_with_visuals.add(source_key)
        doc["nodes"].append(
            {
                "name": name,
                "mesh": mesh_index,
                "extras": {
                    "teldra": identity,
                    "teldraSourceVisibility": {"hidden": "teldraHidden_" in name},
                },
            }
        )
        doc["scenes"][0]["nodes"].append(len(doc["nodes"]) - 1)
        manifest_nodes.append(
            {
                **identity,
                "kind": "building" if matches else "presentation",
                "renderPart": str(ordinal),
            }
        )

    binary.extend(b"\0" * (-len(binary) % 4))
    doc["buffers"] = [{"byteLength": len(binary)}]
    payload = json.dumps(doc, separators=(",", ":")).encode()
    payload += b" " * (-len(payload) % 4)
    body = struct.pack("<II", len(payload), 0x4E4F534A) + payload
    body += struct.pack("<II", len(binary), 0x004E4942) + binary
    glb_path.write_bytes(struct.pack("<4sII", b"glTF", 2, len(body) + 12) + body)
    manifest = {
        "schemaVersion": "0.1.0",
        "coordinateSystem": {"unit": "metre", "handedness": "right", "upAxis": "Z"},
        "source": {"buildingPath": "building.ifc", "buildingSha256": building_sha256},
        "scene": {
            "assetPath": glb_path.name,
            "format": "glb",
            "assetSha256": hashlib.sha256(glb_path.read_bytes()).hexdigest(),
            "canonicalToScene": list(CANONICAL_TO_GLTF),
        },
        "nodes": manifest_nodes,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {
        **primitive_counts,
        "meshParts": len(doc["meshes"]),
        "materials": len(material_index),
        "transportMaterialVariants": len(material_variants),
        "textures": len(doc["images"]),
        "hiddenMeshParts": sum("teldraHidden_" in node["name"] for node in doc["nodes"]),
        "mappedVisualParts": sum(node["kind"] == "building" for node in manifest_nodes),
        "sourceKeysWithVisuals": sorted(source_keys_with_visuals),
        "resources": resources,
        "objSha256": hashlib.sha256(obj_path.read_bytes()).hexdigest(),
    }
