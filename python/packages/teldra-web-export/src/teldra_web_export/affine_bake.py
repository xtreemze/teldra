"""Lossless-identity, static-only GLB derivative from verified IFC affine deltas.

The input is the *source* GLB, not a previous rebake. The new binary is a
replaceable derivative: IFC geometry/GlobalIds, source images/materials, UV
buffers and unselected render parts are never mutated. Unsupported topology
fails before any output is returned.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import struct
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from .exporter import CANONICAL_TO_GLTF, WebSceneExportError

_JSON = 0x4E4F534A
_BIN = 0x004E4942
_MAX_BYTES = 512 * 1024 * 1024
_MAX_VERTICES = 10_000_000


@dataclass(frozen=True, slots=True)
class StaticGlbBakeResult:
    glb: bytes
    source_sha256: str
    baked_sha256: str
    canonical_ids: tuple[str, ...]
    triangles: int


def _source_chunks(payload: bytes) -> tuple[dict[str, Any], bytes]:
    if len(payload) < 28 or len(payload) > _MAX_BYTES:
        raise WebSceneExportError("Source GLB exceeds safe limits or is truncated.")
    magic, version, length = struct.unpack_from("<4sII", payload)
    if magic != b"glTF" or version != 2 or length != len(payload):
        raise WebSceneExportError("Expected a complete glTF 2.0 binary container.")
    offset = 12
    chunks: list[tuple[int, bytes]] = []
    while offset < len(payload):
        if offset + 8 > len(payload):
            raise WebSceneExportError("Truncated GLB chunk header.")
        size, kind = struct.unpack_from("<II", payload, offset)
        offset += 8
        if size % 4 or offset + size > len(payload):
            raise WebSceneExportError("Truncated or misaligned GLB chunk.")
        chunks.append((kind, payload[offset : offset + size]))
        offset += size
    if len(chunks) != 2 or [kind for kind, _ in chunks] != [_JSON, _BIN]:
        raise WebSceneExportError("Static rebake requires exactly one JSON and one BIN GLB chunk.")
    try:
        doc = json.loads(chunks[0][1].rstrip(b" \t\r\n\x00").decode("utf-8"))
    except (ValueError, UnicodeError) as error:
        raise WebSceneExportError("Invalid source GLB JSON.") from error
    if not isinstance(doc, dict):
        raise WebSceneExportError("Source GLB document is not an object.")
    if len(doc.get("buffers", [])) != 1 or doc["buffers"][0].get("uri"):
        raise WebSceneExportError("Static rebake requires one embedded GLB buffer.")
    buffer_length = doc["buffers"][0].get("byteLength")
    if not isinstance(buffer_length, int) or not 0 <= buffer_length <= len(chunks[1][1]):
        raise WebSceneExportError("GLB buffer byteLength is inconsistent with its BIN chunk.")
    return doc, chunks[1][1][:buffer_length]


def _encode(doc: dict[str, Any], binary: bytes) -> bytes:
    if len(binary) > _MAX_BYTES:
        raise WebSceneExportError("Regenerated GLB exceeds the binary safety limit.")
    doc["buffers"][0]["byteLength"] = len(binary)
    encoded = json.dumps(doc, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\x00" * (-len(binary) % 4)
    chunks = struct.pack("<II", len(encoded), _JSON) + encoded
    chunks += struct.pack("<II", len(binary), _BIN) + binary
    if len(chunks) + 12 > _MAX_BYTES:
        raise WebSceneExportError("Regenerated GLB exceeds the file safety limit.")
    return struct.pack("<4sII", b"glTF", 2, len(chunks) + 12) + chunks


def _accessor(
    doc: dict[str, Any],
    binary: bytes,
    index: int,
    *,
    components: int,
    component_type: int,
) -> np.ndarray:
    try:
        accessor = doc["accessors"][index]
        view = doc["bufferViews"][accessor["bufferView"]]
        count = accessor["count"]
        if (
            not isinstance(count, int)
            or not 0 < count <= _MAX_VERTICES
            or accessor.get("sparse")
            or accessor.get("normalized")
            or accessor.get("byteOffset", 0) < 0
            or view.get("byteStride")
            or view.get("buffer") != 0
            or accessor["componentType"] != component_type
            or accessor["type"] != ("SCALAR" if components == 1 else f"VEC{components}")
        ):
            raise ValueError("Unsupported packed accessor layout.")
        dtype = {5126: "<f4", 5121: "<u1", 5123: "<u2", 5125: "<u4"}[component_type]
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        end = offset + count * components * np.dtype(dtype).itemsize
        if not 0 <= offset <= end <= view.get("byteOffset", 0) + view["byteLength"]:
            raise ValueError("Accessor exceeds its declared bufferView.")
        if end > len(binary):
            raise ValueError("Accessor exceeds GLB binary buffer.")
        return np.frombuffer(binary, dtype=dtype, count=count * components, offset=offset).reshape(
            count, components
        )
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise WebSceneExportError("Static rebake requires valid packed GLB accessors.") from error


def _append_accessor(
    doc: dict[str, Any], binary: bytearray, values: np.ndarray, source: int
) -> int:
    original = doc["accessors"][source]
    if original["componentType"] != 5126:
        raise WebSceneExportError("Transformed positions and directions must be float32.")
    result = np.asarray(values, dtype="<f4")
    if not np.isfinite(result).all():
        raise WebSceneExportError("Regenerated vertices must be finite.")
    binary.extend(b"\x00" * (-len(binary) % 4))
    offset = len(binary)
    data = result.tobytes()
    binary.extend(data)
    view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": 34962}
    index = len(doc["bufferViews"])
    doc["bufferViews"].append(view)
    cloned = copy.deepcopy(original)
    cloned["bufferView"] = index
    cloned["byteOffset"] = 0
    cloned.pop("min", None)
    cloned.pop("max", None)
    if original["type"] == "VEC3" and result.shape[1] == 3:
        cloned["min"] = result.min(axis=0).astype(float).tolist()
        cloned["max"] = result.max(axis=0).astype(float).tolist()
    doc["accessors"].append(cloned)
    return len(doc["accessors"]) - 1


def _placement_matrix(matrix: Sequence[float]) -> np.ndarray:
    if len(matrix) != 16 or not all(
        isinstance(v, (float, int)) and math.isfinite(v) for v in matrix
    ):
        raise WebSceneExportError("Rebake requires a finite 4×4 IFC placement matrix.")
    canonical = np.asarray(matrix, dtype=np.float64).reshape((4, 4), order="F")
    linear = canonical[:3, :3]
    if (
        not np.allclose(canonical[3, :], [0, 0, 0, 1], atol=1e-7, rtol=0)
        or not np.allclose(linear[0:2, 2], 0, atol=1e-7, rtol=0)
        or not np.allclose(linear[2, 0:2], 0, atol=1e-7, rtol=0)
        or linear[2, 2] <= 1e-9
        or np.linalg.det(linear) <= 1e-10
        or np.linalg.cond(linear) > 1e8
        or np.max(np.abs(canonical)) > 1e6
    ):
        raise WebSceneExportError(
            "Static rebake requires a nonsingular, positive upright IFC affine."
        )
    frame = np.asarray(CANONICAL_TO_GLTF, dtype=np.float64).reshape((4, 4), order="F")
    return frame @ canonical @ np.linalg.inv(frame)


def _transform_normal(values: np.ndarray, normal_matrix: np.ndarray) -> np.ndarray:
    result = np.asarray(values, dtype=np.float64) @ normal_matrix.T
    lengths = np.linalg.norm(result, axis=1)
    if not np.isfinite(result).all() or (lengths <= 1e-9).any():
        raise WebSceneExportError("Geometry has invalid normals for affine rebake.")
    return result / lengths[:, np.newaxis]


def bake_static_furniture_glb(
    glb: bytes,
    scene_manifest: Mapping[str, Any],
    placements: Sequence[Mapping[str, Any]],
) -> StaticGlbBakeResult:
    """Bake verified upright IFC deltas into *new* packed static GLB vertex accessors.

    This is a deliberately restricted derivative-builder, not an IFC editor.
    Caller must validate each matrix against source/current canonical IFC.
    The manifest's original GLB SHA and canonical nodeKey/GlobalId identity
    are still checked here. The source bytes and source manifest stay untouched.
    """
    source_hash = hashlib.sha256(glb).hexdigest()
    if scene_manifest.get("scene", {}).get("assetSha256") != source_hash:
        raise WebSceneExportError("Source GLB hash does not match the scene manifest.")
    doc, packed = _source_chunks(glb)
    if doc.get("skins") or doc.get("animations"):
        raise WebSceneExportError(
            "Animated or skinned scenes require a separate deformation rebaker."
        )
    if any(name in doc.get("extensionsUsed", []) for name in (
        "KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_mesh_quantization"
    )):
        raise WebSceneExportError("Compressed or quantized mesh accessors require decoding first.")

    manifest_nodes = scene_manifest.get("nodes", [])
    manifest_by_key: dict[str, tuple[str, str]] = {}
    for item in manifest_nodes:
        key = item.get("nodeKey")
        if not key or key in manifest_by_key:
            raise WebSceneExportError("Duplicate or missing scene node identity.")
        manifest_by_key[key] = (item.get("canonicalId"), item.get("ifcGlobalId"))

    matrices: dict[tuple[str, str], np.ndarray] = {}
    for entry in placements:
        pair = (entry.get("canonicalId"), entry.get("ifcGlobalId"))
        if not all(isinstance(value, str) and value for value in pair) or pair in matrices:
            raise WebSceneExportError("Duplicate or invalid placement canonical identity.")
        if not any(item == pair for item in manifest_by_key.values()):
            raise WebSceneExportError("Placement identity has no matching source render nodes.")
        matrices[pair] = _placement_matrix(entry.get("matrix", ()))
    if not matrices:
        raise WebSceneExportError("No validated furniture placements to rebake.")
    if any(not isinstance(node, dict) for node in doc.get("nodes", [])):
        raise WebSceneExportError("Source GLB node records must be objects.")
    if len(doc.get("nodes", [])) > _MAX_VERTICES:
        raise WebSceneExportError("Source GLB contains too many scene nodes.")

    if any(node.get("children") for node in doc.get("nodes", [])):
        # A flattened native export does not use hierarchy anywhere.
        raise WebSceneExportError("Parented source GLB nodes require hierarchy-aware regeneration.")

    rebuilt = copy.deepcopy(doc)
    binary = bytearray(packed)
    selected: set[tuple[str, str]] = set()
    triangles = 0
    for node in rebuilt.get("nodes", []):
        tag = node.get("extras", {}).get("teldra", {})
        pair = (tag.get("canonicalId"), tag.get("ifcGlobalId"))
        if pair not in matrices:
            continue
        key = tag.get("nodeKey")
        if manifest_by_key.get(key) != pair:
            raise WebSceneExportError("Source GLB identity does not match the scene manifest.")
        if any(property_name in node for property_name in (
            "matrix", "translation", "rotation", "scale", "children", "skin", "weights"
        )):
            raise WebSceneExportError("Source render node is not flattened static geometry.")
        mesh_index = node.get("mesh")
        if not isinstance(mesh_index, int) or mesh_index >= len(doc["meshes"]) or mesh_index < 0:
            raise WebSceneExportError("Selected source node has no valid GLB mesh.")
        source_mesh = doc["meshes"][mesh_index]
        if source_mesh.get("weights"):
            raise WebSceneExportError("Morphable source mesh cannot be baked statically.")
        delta = matrices[pair]
        linear = delta[:3, :3]
        normal_matrix = np.linalg.inv(linear).T
        new_mesh = copy.deepcopy(source_mesh)
        if not new_mesh.get("primitives"):
            raise WebSceneExportError("Selected source GLB mesh contains no geometry.")
        for primitive in new_mesh["primitives"]:
            if (
                primitive.get("mode", 4) != 4
                or primitive.get("targets")
                or primitive.get("extensions")
            ):
                raise WebSceneExportError("Static rebake supports uncompressed triangles only.")
            attrs = primitive.get("attributes", {})
            if "POSITION" not in attrs or any(
                key.startswith(("JOINTS_", "WEIGHTS_")) for key in attrs
            ):
                raise WebSceneExportError("Static rebake requires non-skinned positions.")
            positions = _accessor(doc, packed, attrs["POSITION"], components=3, component_type=5126)
            index_ref = primitive.get("indices")
            if not isinstance(index_ref, int):
                raise WebSceneExportError("Static rebake requires indexed triangle geometry.")
            index_accessor = doc["accessors"][index_ref]
            index_type = index_accessor.get("componentType")
            if index_type not in (5121, 5123, 5125):
                raise WebSceneExportError("Invalid triangle index component type.")
            indices = _accessor(doc, packed, index_ref, components=1, component_type=index_type)
            if len(indices) % 3 or indices.max() >= len(positions):
                raise WebSceneExportError(
                    "Indexed triangle geometry is incomplete or out of range."
                )
            transformed = positions.astype(np.float64) @ linear.T + delta[:3, 3]
            attrs["POSITION"] = _append_accessor(rebuilt, binary, transformed, attrs["POSITION"])
            transformed_normals = None
            if "NORMAL" in attrs:
                normals = _accessor(doc, packed, attrs["NORMAL"], components=3, component_type=5126)
                if len(normals) != len(positions):
                    raise WebSceneExportError("Normal/position vertex counts differ.")
                transformed_normals = _transform_normal(normals, normal_matrix)
                attrs["NORMAL"] = _append_accessor(
                    rebuilt, binary, transformed_normals, attrs["NORMAL"]
                )
            if "TANGENT" in attrs:
                if transformed_normals is None:
                    raise WebSceneExportError("Tangents without normals cannot be rebaked.")
                tangents = _accessor(
                    doc, packed, attrs["TANGENT"], components=4, component_type=5126
                )
                if len(tangents) != len(positions):
                    raise WebSceneExportError("Tangent/position vertex counts differ.")
                rotated = tangents[:, :3].astype(np.float64) @ linear.T
                rotated -= (
                    (rotated * transformed_normals).sum(axis=1)[:, None] * transformed_normals
                )
                oriented = _transform_normal(rotated, np.eye(3))
                if not np.isfinite(tangents[:, 3]).all() or not np.all(
                    np.isclose(np.abs(tangents[:, 3]), 1, atol=1e-5)
                ):
                    raise WebSceneExportError("Invalid source tangent handedness.")
                attrs["TANGENT"] = _append_accessor(
                    rebuilt, binary, np.column_stack((oriented, tangents[:, 3])), attrs["TANGENT"]
                )
            triangles += len(indices) // 3
        # Sharing the *source* mesh is safe: only the target node receives this copy.
        node["mesh"] = len(rebuilt["meshes"])
        rebuilt["meshes"].append(new_mesh)
        selected.add(pair)
    if selected != set(matrices):
        raise WebSceneExportError("Not every requested IFC object has a regenerated render part.")
    baked = _encode(rebuilt, bytes(binary))
    return StaticGlbBakeResult(
        glb=baked,
        source_sha256=source_hash,
        baked_sha256=hashlib.sha256(baked).hexdigest(),
        canonical_ids=tuple(sorted({identifier for identifier, _ in selected})),
        triangles=triangles,
    )
