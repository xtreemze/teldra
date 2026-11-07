"""End-to-end IFC-authoritative, hash-bound static GLB archive regeneration."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import struct
import zipfile
from pathlib import Path

import ifcopenshell
import ifcopenshell.util.placement
import numpy as np
import pytest
from teldra_web_export import rebake_static_teldra_archive
from teldra_web_export.affine_bake import _source_chunks
from teldra_web_export.canonical_visuals import attach_furniture_geometry
from teldra_web_export.exporter import WebSceneExportError
from teldra_web_export.wavefront import export_wavefront_scene

GUID = "16W6mYG0DO8hR8U$bz6FSv"
OBJ = """mtllib materials.mtl
v 0 0 0
v 100 0 0
v 0 100 0
vn 0 0 1
g teldraVisible_chair_1
usemtl mat
f 1//1 2//1 3//1
"""


def _json(doc):
    return (json.dumps(doc, sort_keys=True, indent=2) + "\n").encode()


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _pack(entries: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as file:
        for name, data in sorted(entries.items()):
            file.writestr(name, data)
    return output.getvalue()


def _unpack(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as file:
        return {name: file.read(name) for name in file.namelist()}


def fixture(tmp_path):
    root = Path(__file__).parents[4]
    source = ifcopenshell.open(str(root / "fixtures/projects/golden-home/building.ifc"))
    source_dir = tmp_path / "assets"
    source_dir.mkdir()
    (source_dir / "source.obj").write_text(OBJ)
    (source_dir / "materials.mtl").write_text("newmtl mat\nKd 0.8 0.6 0.4\n")
    glb_path = source_dir / "building.glb"
    manifest_path = source_dir / "scene.manifest.json"
    export_wavefront_scene(
        source_dir / "source.obj",
        glb_path,
        manifest_path,
        building_sha256="a" * 64,
        source_bindings={"pieceOfFurniture:chair": ("chair", GUID)},
    )
    assert attach_furniture_geometry(source, glb_path) == {
        "representedElements": 1, "triangles": 1
    }
    source_ifc = source.to_string().encode()
    current = ifcopenshell.file.from_string(source_ifc.decode())
    item = current.by_guid(GUID).Representation.Representations[0].Items[0]
    target = item.MappingTarget
    item.MappingTarget = current.create_entity(
        "IfcCartesianTransformationOperator3DnonUniform",
        Axis1=None,
        Axis2=None,
        LocalOrigin=target.LocalOrigin,
        Scale=1.5,
        Axis3=None,
        Scale2=0.75,
        Scale3=1.25,
    )
    current_ifc = current.to_string().encode()
    frame_source = ifcopenshell.util.placement.get_local_placement(
        source.by_guid(GUID).ObjectPlacement
    )
    frame_current = ifcopenshell.util.placement.get_local_placement(
        current.by_guid(GUID).ObjectPlacement
    )
    ratio = [1.5, 0.75, 1.25]
    delta = frame_current @ np.diag([*ratio, 1]) @ np.linalg.inv(frame_source)
    placement = {
        "canonicalId": "chair",
        "ifcGlobalId": GUID,
        "matrix": delta.flatten(order="F").tolist(),
        "scale": ratio,
    }
    scene = json.loads(manifest_path.read_bytes())
    glb = glb_path.read_bytes()
    scene["source"]["buildingSha256"] = _sha(source_ifc)
    scene["scene"]["assetSha256"] = _sha(glb)
    twin = {
        "schemaVersion": "0.1.0",
        "building": {"ifcSchema": "IFC4", "refs": [{
            "id": "chair", "ifcGlobalId": GUID, "kind": "furniture", "name": "Chair"
        }]},
        "devices": [], "bindings": [],
    }
    record = {
        "version": 2,
        "sourceBuildingSha256": _sha(source_ifc),
        "buildingSha256": _sha(current_ifc),
        "sceneAssetSha256": _sha(glb),
        "placements": [placement],
    }
    entries = {
        "building.ifc": current_ifc,
        "building.glb": glb,
        "scene.manifest.json": _json(scene),
        "twin.json": _json(twin),
        "source.sh3d": b"immutable original design",
        "teldra/scene-source.ifc": source_ifc,
        "teldra/scene-placement-overrides.json": _json(record),
    }
    manifest = {
        "formatVersion": "0.1.0",
        "building": {"path": "building.ifc", "sha256": _sha(current_ifc)},
        "twin": {"path": "twin.json", "sha256": _sha(entries["twin.json"])},
        "derived": [{"path": name, "sha256": _sha(entries[name])} for name in entries
                    if name not in ("building.ifc", "twin.json")],
    }
    entries["project.json"] = _json(manifest)
    return entries


def test_rebases_exact_canonical_ifc_and_preserves_source_assets(tmp_path):
    original = fixture(tmp_path)
    data = _pack(original)
    result = rebake_static_teldra_archive(data)
    updated = _unpack(result.archive)
    assert result.current_ifc_sha256 == _sha(original["building.ifc"])
    assert result.source_scene_sha256 == _sha(original["building.glb"])
    assert result.baked.triangles == 1
    assert result.baked.canonical_ids == ("chair",)
    assert updated["building.ifc"] == original["building.ifc"]
    assert updated["twin.json"] == original["twin.json"]
    assert updated["source.sh3d"] == original["source.sh3d"]
    assert "teldra/scene-source.ifc" not in updated
    assert "teldra/scene-placement-overrides.json" not in updated

    output_manifest = json.loads(updated["scene.manifest.json"])
    assert output_manifest["source"]["buildingSha256"] == _sha(updated["building.ifc"])
    assert output_manifest["scene"]["assetSha256"] == _sha(updated["building.glb"])
    for record in [json.loads(updated["project.json"])["building"],
                   json.loads(updated["project.json"])["twin"],
                   *json.loads(updated["project.json"])["derived"]]:
        assert _sha(updated[record["path"]]) == record["sha256"]
    assert result.archive == rebake_static_teldra_archive(data).archive

    before_doc, before_bin = _source_chunks(original["building.glb"])
    after_doc, after_bin = _source_chunks(updated["building.glb"])
    assert before_bin == after_bin[:len(before_bin)]
    assert before_doc["materials"] == after_doc["materials"]
    assert before_doc["nodes"][0]["extras"] == after_doc["nodes"][0]["extras"]
    original_mesh = before_doc["meshes"][0]["primitives"][0]
    derived_mesh = after_doc["meshes"][after_doc["nodes"][0]["mesh"]]["primitives"][0]
    assert derived_mesh["material"] == original_mesh["material"]
    assert derived_mesh["indices"] == original_mesh["indices"]


def test_refuses_tampered_ifc_geometry_matrix_and_source_hashes(tmp_path):
    clean = fixture(tmp_path)
    record_path = "teldra/scene-placement-overrides.json"
    scene_path = "scene.manifest.json"
    project_path = "project.json"

    def changed_case(change):
        entries = copy.deepcopy(clean)
        change(entries)
        # Recompute outer project checksums, simulating a deliberately
        # malicious edit rather than only an accidentally corrupted ZIP.
        project = json.loads(entries[project_path])
        for item in [project["building"], project["twin"], *project["derived"]]:
            item["sha256"] = _sha(entries[item["path"]])
        entries[project_path] = _json(project)
        return _pack(entries)

    def altered_matrix(entries):
        record = json.loads(entries[record_path])
        record["placements"][0]["matrix"][12] += 0.5
        entries[record_path] = _json(record)

    def altered_scale(entries):
        record = json.loads(entries[record_path])
        record["placements"][0]["scale"] = [1.1, 1, 1]
        entries[record_path] = _json(record)

    def stale_scene(entries):
        scene = json.loads(entries[scene_path])
        scene["source"]["buildingSha256"] = "0" * 64
        entries[scene_path] = _json(scene)

    def tamper_current_ifc(entries):
        entries["building.ifc"] = entries["building.ifc"].replace(b"IFCCARTESIANPOINTLIST3D", b"IFCCARTESIANPOINTLISTX")

    for change in (altered_matrix, altered_scale, stale_scene, tamper_current_ifc):
        with pytest.raises(WebSceneExportError):
            rebake_static_teldra_archive(changed_case(change))


def test_rejects_unsafe_archive_paths_and_duplicate_entries(tmp_path):
    entries = fixture(tmp_path)
    with pytest.raises(WebSceneExportError, match="duplicate"):
        duplicate = io.BytesIO()
        with zipfile.ZipFile(duplicate, "w") as file:
            file.writestr("project.json", entries["project.json"])
            file.writestr("project.json", entries["project.json"])
        rebake_static_teldra_archive(duplicate.getvalue())

    unsafe = io.BytesIO()
    with zipfile.ZipFile(unsafe, "w") as file:
        for name, payload in entries.items():
            file.writestr(name, payload)
        file.writestr("../evil", b"do not extract")
    with pytest.raises(WebSceneExportError, match="unsafe"):
        rebake_static_teldra_archive(unsafe.getvalue())
