from __future__ import annotations

import hashlib
import json
import multiprocessing
import struct
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import ifcopenshell
import ifcopenshell.geom

_JSON_CHUNK = 0x4E4F534A
_GLB_MAGIC = b"glTF"
_GLB_VERSION = 2

# Column-major matrix: rotate canonical right-handed Z-up coordinates -90° about X
# into glTF's right-handed Y-up transport frame:
# (x, y, z) -> (x, z, -y)
CANONICAL_TO_GLTF: tuple[float, ...] = (
    1.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    -1.0,
    0.0,
    0.0,
    1.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    1.0,
)


class WebSceneExportError(RuntimeError):
    """Raised when a derived web scene cannot preserve canonical identity."""


@dataclass(frozen=True, slots=True)
class WebSceneExportResult:
    glb_path: Path
    manifest_path: Path
    mapped_node_count: int


def export_ifc_web_scene(
    ifc_path: str | Path,
    glb_path: str | Path,
    manifest_path: str | Path,
    *,
    canonical_by_global_id: Mapping[str, str],
    source_building_path: str = "building.ifc",
) -> WebSceneExportResult:
    """Serialize IFC geometry to GLB and attach Teldra canonical identity metadata."""

    source = Path(ifc_path)
    glb = Path(glb_path)
    manifest = Path(manifest_path)

    if not canonical_by_global_id:
        raise WebSceneExportError("At least one IFC GlobalId mapping is required.")

    model = ifcopenshell.open(str(source))
    _serialize_glb(model, glb)

    document, chunks = _read_glb(glb)
    mapped_nodes = _annotate_scene_nodes(document, canonical_by_global_id)

    missing = sorted(set(canonical_by_global_id) - {item["ifcGlobalId"] for item in mapped_nodes})
    if missing:
        raise WebSceneExportError(
            "GLB serialization did not expose mapped IFC elements: " + ", ".join(missing)
        )

    _write_glb(glb, document, chunks)

    source_sha = _sha256(source)
    glb_sha = _sha256(glb)

    scene_manifest = {
        "schemaVersion": "0.1.0",
        "coordinateSystem": {
            "unit": "metre",
            "handedness": "right",
            "upAxis": "Z",
        },
        "source": {
            "buildingPath": source_building_path,
            "buildingSha256": source_sha,
        },
        "scene": {
            "assetPath": glb.name,
            "assetSha256": glb_sha,
            "format": "glb",
            "canonicalToScene": list(CANONICAL_TO_GLTF),
        },
        "nodes": mapped_nodes,
    }

    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(
        json.dumps(scene_manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    return WebSceneExportResult(
        glb_path=glb,
        manifest_path=manifest,
        mapped_node_count=len(mapped_nodes),
    )


def read_glb_json(path: str | Path) -> dict[str, Any]:
    document, _ = _read_glb(Path(path))
    return document


def _serialize_glb(model: ifcopenshell.file, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)

    settings = ifcopenshell.geom.settings()
    settings.set(
        "dimensionality",
        ifcopenshell.ifcopenshell_wrapper.CURVES_SURFACES_AND_SOLIDS,
    )
    settings.set("apply-default-materials", True)
    settings.set("use-element-guids", True)

    serializer = ifcopenshell.geom.serializers.gltf(str(destination), settings)
    serializer.setFile(model)
    serializer.setUnitNameAndMagnitude("METER", 1.0)
    serializer.writeHeader()

    iterator = ifcopenshell.geom.iterator(
        settings,
        model,
        multiprocessing.cpu_count(),
    )

    if iterator.initialize():
        while True:
            serializer.write(iterator.get())
            if not iterator.next():
                break

    serializer.finalize()

    if not destination.is_file():
        raise WebSceneExportError(f'IfcOpenShell did not create GLB "{destination}".')


def _annotate_scene_nodes(
    document: dict[str, Any],
    canonical_by_global_id: Mapping[str, str],
) -> list[dict[str, Any]]:
    nodes = document.get("nodes")
    meshes = document.get("meshes", [])

    if not isinstance(nodes, list):
        raise WebSceneExportError("GLB has no node array.")

    matches: list[tuple[int, str]] = []

    for index, raw_node in enumerate(nodes):
        if not isinstance(raw_node, dict):
            continue

        labels = _node_labels(raw_node, meshes)
        global_ids = [
            global_id
            for global_id in canonical_by_global_id
            if any(global_id in label for label in labels)
        ]

        if len(global_ids) > 1:
            raise WebSceneExportError(
                f"GLB node {index} ambiguously references multiple IFC GlobalIds."
            )

        if len(global_ids) == 1:
            matches.append((index, global_ids[0]))

    counts: dict[str, int] = {}
    totals: dict[str, int] = {}
    for _, global_id in matches:
        totals[global_id] = totals.get(global_id, 0) + 1

    manifest_nodes: list[dict[str, Any]] = []

    for node_index, global_id in matches:
        raw_node = nodes[node_index]
        ordinal = counts.get(global_id, 0)
        counts[global_id] = ordinal + 1

        if totals[global_id] == 1:
            node_key = f"ifc:{global_id}:body"
            render_part = "body"
        else:
            node_key = f"ifc:{global_id}:body:{ordinal}"
            render_part = f"body:{ordinal}"

        extras = raw_node.get("extras")
        if extras is None:
            extras = {}
            raw_node["extras"] = extras
        if not isinstance(extras, dict):
            raise WebSceneExportError(f"GLB node {node_index} has non-object extras metadata.")

        extras["teldra"] = {
            "nodeKey": node_key,
            "canonicalId": canonical_by_global_id[global_id],
            "ifcGlobalId": global_id,
        }

        manifest_nodes.append(
            {
                "nodeKey": node_key,
                "canonicalId": canonical_by_global_id[global_id],
                "ifcGlobalId": global_id,
                "kind": "building",
                "renderPart": render_part,
            }
        )

    return manifest_nodes


def _node_labels(node: dict[str, Any], meshes: list[Any]) -> tuple[str, ...]:
    labels: list[str] = []

    name = node.get("name")
    if isinstance(name, str):
        labels.append(name)

    mesh_index = node.get("mesh")
    if isinstance(mesh_index, int) and 0 <= mesh_index < len(meshes):
        mesh = meshes[mesh_index]
        if isinstance(mesh, dict):
            mesh_name = mesh.get("name")
            if isinstance(mesh_name, str):
                labels.append(mesh_name)

    return tuple(labels)


def _read_glb(path: Path) -> tuple[dict[str, Any], list[tuple[int, bytes]]]:
    data = path.read_bytes()
    if len(data) < 12:
        raise WebSceneExportError("GLB is shorter than its header.")

    magic, version, total_length = struct.unpack_from("<4sII", data, 0)
    if magic != _GLB_MAGIC or version != _GLB_VERSION:
        raise WebSceneExportError("Unsupported GLB header.")
    if total_length != len(data):
        raise WebSceneExportError("GLB header length does not match file length.")

    chunks: list[tuple[int, bytes]] = []
    document: dict[str, Any] | None = None
    offset = 12

    while offset < len(data):
        if offset + 8 > len(data):
            raise WebSceneExportError("Truncated GLB chunk header.")

        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        end = offset + chunk_length
        if end > len(data):
            raise WebSceneExportError("Truncated GLB chunk payload.")

        payload = data[offset:end]
        offset = end
        chunks.append((chunk_type, payload))

        if chunk_type == _JSON_CHUNK:
            if document is not None:
                raise WebSceneExportError("GLB contains multiple JSON chunks.")
            decoded = payload.rstrip(b" \t\r\n\x00").decode("utf-8")
            loaded = json.loads(decoded)
            if not isinstance(loaded, dict):
                raise WebSceneExportError("GLB JSON root must be an object.")
            document = loaded

    if document is None:
        raise WebSceneExportError("GLB contains no JSON chunk.")

    return document, chunks


def _write_glb(
    path: Path,
    document: dict[str, Any],
    chunks: list[tuple[int, bytes]],
) -> None:
    json_payload = json.dumps(
        document,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    json_payload += b" " * ((4 - len(json_payload) % 4) % 4)

    encoded_chunks: list[bytes] = []
    replaced_json = False

    for chunk_type, payload in chunks:
        if chunk_type == _JSON_CHUNK:
            if replaced_json:
                continue
            payload = json_payload
            replaced_json = True

        encoded_chunks.append(struct.pack("<II", len(payload), chunk_type) + payload)

    if not replaced_json:
        raise WebSceneExportError("Cannot rewrite GLB without JSON chunk.")

    body = b"".join(encoded_chunks)
    header = struct.pack("<4sII", _GLB_MAGIC, _GLB_VERSION, 12 + len(body))
    path.write_bytes(header + body)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
