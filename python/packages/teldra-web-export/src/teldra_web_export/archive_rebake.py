"""Rebase a hash-bound .teldra scene derivative onto its current canonical IFC.

This is an opt-in/offline operation. The saved IFC must already contain a
canonical edit; the rebaker never authors IFC geometry. Only a verified
source-IFC/current-IFC mapped-instance delta can drive the GLB vertex bake.
The returned archive is independently openable without placement overrides.
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import zipfile
from dataclasses import dataclass
from typing import Any

import ifcopenshell
import ifcopenshell.util.placement
import numpy as np

from .affine_bake import StaticGlbBakeResult, bake_static_furniture_glb
from .exporter import WebSceneExportError

_RECONCILIATION = "teldra/scene-placement-overrides.json"
_ORIGINAL_IFC = "teldra/scene-source.ifc"
_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class StaticArchiveRebakeResult:
    archive: bytes
    baked: StaticGlbBakeResult
    current_ifc_sha256: str
    source_scene_sha256: str


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def _valid_path(path: str) -> bool:
    parts = path.split("/")
    return bool(path) and not path.startswith("/") and "\\" not in path and (
        all(part not in ("", ".", "..") for part in parts)
    ) and ":" not in path


def _read_archive(payload: bytes) -> dict[str, bytes]:
    if len(payload) > _MAX_ARCHIVE_BYTES:
        raise WebSceneExportError("Teldra archive exceeds the rebake safety limit.")
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as zip_file:
            records = zip_file.infolist()
            if (
                len(records) > 100_000
                or sum(item.file_size for item in records) > _MAX_ARCHIVE_BYTES
            ):
                raise WebSceneExportError("Teldra archive has too many or oversized entries.")
            if len({item.filename for item in records}) != len(records) or any(
                not _valid_path(item.filename) or item.is_dir() for item in records
            ):
                raise WebSceneExportError("Teldra archive contains duplicate or unsafe paths.")
            return {item.filename: zip_file.read(item.filename) for item in records}
    except (zipfile.BadZipFile, OSError, EOFError, RuntimeError) as error:
        raise WebSceneExportError("Cannot read the source Teldra archive.") from error


def _read_json(entries: dict[str, bytes], path: str) -> dict[str, Any]:
    if path not in entries:
        raise WebSceneExportError(f"Required archive asset is absent: {path}")
    try:
        loaded = json.loads(entries[path])
        if not isinstance(loaded, dict):
            raise ValueError("JSON document is not an object.")
        return loaded
    except (UnicodeDecodeError, ValueError) as error:
        raise WebSceneExportError(f"Invalid archive JSON: {path}") from error


def _assert_record(entries: dict[str, bytes], item: dict[str, Any]) -> bytes:
    path, wanted = item.get("path"), item.get("sha256")
    if not isinstance(path, str) or not _valid_path(path) or path not in entries:
        raise WebSceneExportError("Archive references a missing or invalid asset path.")
    value = entries[path]
    if _sha(value) != wanted:
        raise WebSceneExportError(f"Archive manifest checksum mismatch: {path}")
    return value


def _direction(value: Any, expected: tuple[float, float, float]) -> None:
    if value is not None and not np.allclose(value.DirectionRatios, expected, atol=1e-8, rtol=0):
        raise WebSceneExportError("Unsupported nonidentity IFC mapping axes.")


def _source_shape(entity: Any) -> tuple[Any, np.ndarray]:
    if entity is None or entity.is_a() not in (
        "IfcFurniture", "IfcLightFixture", "IfcBuildingElementProxy"
    ):
        raise WebSceneExportError(
            "Only mapped IFC furniture, light fixtures and proxies can rebake."
        )
    definition = entity.Representation
    if definition is None or len(definition.Representations) != 1:
        raise WebSceneExportError("Rebake requires exactly one IFC product shape representation.")
    representation = definition.Representations[0]
    if (
        representation.RepresentationIdentifier != "Body"
        or representation.RepresentationType != "MappedRepresentation"
        or len(representation.Items) != 1
    ):
        raise WebSceneExportError("Only an owned Body/MappedRepresentation can rebake.")
    item = representation.Items[0]
    if not item.is_a("IfcMappedItem"):
        raise WebSceneExportError("Mapped source geometry is missing.")
    source = item.MappingSource
    origin = source.MappingOrigin
    if (
        not origin.is_a("IfcAxis2Placement3D")
        or not np.allclose(origin.Location.Coordinates, (0, 0, 0), atol=1e-8, rtol=0)
    ):
        raise WebSceneExportError("Mapped geometry origin must be identity.")
    _direction(origin.Axis, (0, 0, 1))
    _direction(origin.RefDirection, (1, 0, 0))
    body = source.MappedRepresentation
    if (
        body.RepresentationIdentifier != "Body"
        or body.RepresentationType != "Tessellation"
        or len(body.Items) != 1
        or not body.Items[0].is_a("IfcTriangulatedFaceSet")
    ):
        raise WebSceneExportError("This rebaker supports only original IFC triangulated geometry.")
    target = item.MappingTarget
    if (
        target.is_a() not in (
            "IfcCartesianTransformationOperator3D",
            "IfcCartesianTransformationOperator3DnonUniform",
        )
        or not np.allclose(target.LocalOrigin.Coordinates, (0, 0, 0), atol=1e-8, rtol=0)
    ):
        raise WebSceneExportError("Unsupported mapped-instance transformation target.")
    _direction(target.Axis1, (1, 0, 0))
    _direction(target.Axis2, (0, 1, 0))
    _direction(target.Axis3, (0, 0, 1))
    uniform = target.Scale if target.Scale is not None else 1.0
    scale = np.array(
        [
            uniform,
            getattr(target, "Scale2", None) or uniform,
            getattr(target, "Scale3", None) or uniform,
        ],
        dtype=np.float64,
    )
    if not np.isfinite(scale).all() or (scale <= 0).any() or (scale > 1000).any():
        raise WebSceneExportError("Invalid canonical IFC MappingTarget scale.")
    return body.Items[0], scale


def _same_tessellation(a: Any, b: Any) -> bool:
    return (
        np.array_equal(np.asarray(a.Coordinates.CoordList), np.asarray(b.Coordinates.CoordList))
        and np.array_equal(np.asarray(a.CoordIndex), np.asarray(b.CoordIndex))
        and a.Closed == b.Closed
    )


def _verify_ifc_delta(source: Any, current: Any, placement: dict[str, Any]) -> None:
    guid = placement.get("ifcGlobalId")
    if not isinstance(guid, str) or not guid:
        raise WebSceneExportError("Missing placed IFC GlobalId.")
    before, after = source.by_guid(guid), current.by_guid(guid)
    if before is None or after is None or before.GlobalId != after.GlobalId:
        raise WebSceneExportError("Placed IFC GlobalId disappeared from canonical building.")
    source_geom, source_scale = _source_shape(before)
    current_geom, current_scale = _source_shape(after)
    if not _same_tessellation(source_geom, current_geom):
        raise WebSceneExportError(
            "Source IFC triangulated geometry changed and cannot be rebased."
        )
    ratio = current_scale / source_scale
    scaled = not np.allclose(ratio, [1, 1, 1], atol=1e-8, rtol=0)
    declared = placement.get("scale")
    if scaled != (declared is not None):
        raise WebSceneExportError("Placement scale record does not match canonical IFC changes.")
    if scaled and (
        not isinstance(declared, list)
        or len(declared) != 3
        or not np.allclose(declared, ratio, atol=1e-6, rtol=0)
    ):
        raise WebSceneExportError(
            "Placement ratio differs from canonical IFC mapped geometry."
        )
    try:
        original_pose = np.asarray(
            ifcopenshell.util.placement.get_local_placement(before.ObjectPlacement), dtype=float
        )
        current_pose = np.asarray(
            ifcopenshell.util.placement.get_local_placement(after.ObjectPlacement), dtype=float
        )
        expected = current_pose @ np.diag([*ratio, 1.0]) @ np.linalg.inv(original_pose)
        recorded = np.asarray(placement["matrix"], dtype=float).reshape((4, 4), order="F")
    except (ValueError, TypeError, KeyError, np.linalg.LinAlgError) as error:
        raise WebSceneExportError(
            "Cannot read the canonical IFC source/current placements."
        ) from error
    if not np.isfinite(expected).all() or not np.allclose(
        recorded, expected, atol=1e-6, rtol=1e-6
    ):
        raise WebSceneExportError("Placement matrix does not match source/current canonical IFC.")


def _model(bytes_: bytes) -> Any:
    try:
        model = ifcopenshell.file.from_string(bytes_.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, RuntimeError) as error:
        raise WebSceneExportError("Invalid canonical IFC4 file in archive.") from error
    if model.schema != "IFC4":
        raise WebSceneExportError("Only canonical IFC4 is supported for derivative rebake.")
    length_units = [
        unit
        for unit in model.by_type("IfcProject")[0].UnitsInContext.Units
        if unit.UnitType == "LENGTHUNIT"
    ]
    if (
        len(length_units) != 1
        or not length_units[0].is_a("IfcSIUnit")
        or length_units[0].Name != "METRE"
        or length_units[0].Prefix is not None
    ):
        raise WebSceneExportError("Rebake requires unprefixed metre IFC project units.")
    return model


def rebake_static_teldra_archive(source_archive: bytes) -> StaticArchiveRebakeResult:
    """Generate a new, self-contained .teldra with baked GLB + current IFC provenance.

    Only archives with existing hash-bound placement reconciliation qualify.
    The previous scene-source IFC and delta record are consumed; a future edit
    now starts from the new GLB and current IFC as a matching baseline.
    """
    entries = _read_archive(source_archive)
    project = _read_json(entries, "project.json")
    scene_manifest = _read_json(entries, "scene.manifest.json")
    current_ifc = _assert_record(entries, project["building"])
    _assert_record(entries, project["twin"])
    for item in project.get("derived", []):
        _assert_record(entries, item)
    source_info = scene_manifest.get("source", {})
    scene_info = scene_manifest.get("scene", {})
    source_path, scene_path = source_info.get("buildingPath"), scene_info.get("assetPath")
    if source_path != project["building"]["path"] or not isinstance(scene_path, str):
        raise WebSceneExportError("Scene provenance does not reference canonical project assets.")
    if _sha(entries[scene_path]) != scene_info.get("assetSha256"):
        raise WebSceneExportError("Scene GLB hash mismatch.")
    if _ORIGINAL_IFC not in entries or _RECONCILIATION not in entries:
        raise WebSceneExportError("Scene rebake requires a source IFC and saved reconciliation.")
    source_ifc = entries[_ORIGINAL_IFC]
    saved = _read_json(entries, _RECONCILIATION)
    if (
        saved.get("version") not in (1, 2)
        or saved.get("sourceBuildingSha256") != _sha(source_ifc)
        or saved.get("sourceBuildingSha256") != source_info.get("buildingSha256")
        or saved.get("buildingSha256") != _sha(current_ifc)
        or saved.get("sceneAssetSha256") != _sha(entries[scene_path])
        or not isinstance(saved.get("placements"), list)
    ):
        raise WebSceneExportError("Scene reconciliation provenance does not match the archive.")
    # Confirm original/canonical IFC agree on each declared placement *before*
    # entering the derived GLB transformer.
    original_model = _model(source_ifc)
    current_model = _model(current_ifc)
    twin = _read_json(entries, project["twin"]["path"])
    refs = {
        (reference["id"], reference["ifcGlobalId"])
        for reference in twin.get("building", {}).get("refs", [])
    }
    for placement in saved["placements"]:
        if (placement.get("canonicalId"), placement.get("ifcGlobalId")) not in refs:
            raise WebSceneExportError("Scene placement lacks authoritative twin IFC identity.")
        _verify_ifc_delta(original_model, current_model, placement)
    baked = bake_static_furniture_glb(entries[scene_path], scene_manifest, saved["placements"])
    new_scene = copy.deepcopy(scene_manifest)
    new_scene["source"]["buildingSha256"] = _sha(current_ifc)
    new_scene["scene"]["assetSha256"] = baked.baked_sha256
    new_scene_bytes = _json_bytes(new_scene)
    new_project = copy.deepcopy(project)
    new_derived = []
    for item in project.get("derived", []):
        if item["path"] in (_RECONCILIATION, _ORIGINAL_IFC):
            continue
        if item["path"] == scene_path:
            new_derived.append({"path": scene_path, "sha256": baked.baked_sha256})
        elif item["path"] == "scene.manifest.json":
            new_derived.append({"path": "scene.manifest.json", "sha256": _sha(new_scene_bytes)})
        else:
            new_derived.append(item)
    new_project["derived"] = new_derived
    output_entries = {
        key: value
        for key, value in entries.items()
        if key not in (_RECONCILIATION, _ORIGINAL_IFC)
    }
    output_entries[scene_path] = baked.glb
    output_entries["scene.manifest.json"] = new_scene_bytes
    output_entries["project.json"] = _json_bytes(new_project)

    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as result:
        for path in sorted(output_entries):
            result.writestr(path, output_entries[path])
    archive = stream.getvalue()
    reopened = _read_archive(archive)
    if _sha(reopened[scene_path]) != baked.baked_sha256:
        raise WebSceneExportError("Regenerated GLB failed its archive readback checksum.")
    return StaticArchiveRebakeResult(
        archive=archive,
        baked=baked,
        current_ifc_sha256=_sha(current_ifc),
        source_scene_sha256=_sha(entries[scene_path]),
    )
