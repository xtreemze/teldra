"""Static IFC-affine GLB rebake: source provenance, exact geometry and failure isolation."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import struct
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from teldra_web_export.affine_bake import (
    _source_chunks,
    bake_static_furniture_glb,
)
from teldra_web_export.exporter import WebSceneExportError
from teldra_web_export.wavefront import export_wavefront_scene

CHAIR_GUID = "16W6mYG0DO8hR8U$bz6FSv"
TABLE_GUID = "1nVyzgM_L0swCqTNOVUCx6"
# The native Wavefront converter emits independent, flattened scene nodes.
OBJ = """mtllib source.mtl
v 0 0 0
v 100 0 0
v 0 100 0
vt 0 0
vt 1 0
vt 0 1
vn 0 0 1
g teldraVisible_chair_1
usemtl material
f 1/1/1 2/2/1 3/3/1
g teldraVisible_table_2
usemtl material
f 1/1/1 3/3/1 2/2/1
"""


def scene(tmp_path: Path):
    (tmp_path / "source.obj").write_text(OBJ)
    (tmp_path / "source.mtl").write_text(
        "newmtl material\nKd 0.8 0.7 0.6\nNs 50\nmap_Kd texture.png\n"
    )
    image = io.BytesIO()
    Image.new("RGB", (2, 2), (120, 80, 40)).save(image, format="PNG")
    (tmp_path / "texture.png").write_bytes(image.getvalue())
    glb_path = tmp_path / "scene.glb"
    manifest_path = tmp_path / "scene.manifest.json"
    export_wavefront_scene(
        tmp_path / "source.obj",
        glb_path,
        manifest_path,
        building_sha256="a" * 64,
        source_bindings={
            "pieceOfFurniture:chair": ("chair", CHAIR_GUID),
            "pieceOfFurniture:table": ("table", TABLE_GUID),
        },
    )
    return glb_path.read_bytes(), json.loads(manifest_path.read_text())


def _values(doc, binary, accessor_index: int) -> np.ndarray:
    accessor = doc["accessors"][accessor_index]
    view = doc["bufferViews"][accessor["bufferView"]]
    size = {"VEC3": 3, "VEC2": 2, "VEC4": 4, "SCALAR": 1}[accessor["type"]]
    dtype = {5126: "<f4", 5125: "<u4", 5123: "<u2"}[accessor["componentType"]]
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    return np.frombuffer(
        binary, dtype=dtype, count=accessor["count"] * size, offset=offset
    ).reshape((-1, size))


def _placement(matrix, *, identity="chair", guid=CHAIR_GUID):
    return {"canonicalId": identity, "ifcGlobalId": guid, "matrix": matrix}


AFFINE = [
    1.5,
    0.5,
    0,
    0,
    0.3,
    1.2,
    0,
    0,
    0,
    0,
    2,
    0,
    2,
    -1,
    0.5,
    1,
]
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def test_rebake_preserves_original_texture_materials_uvs_and_other_objects(tmp_path):
    source, manifest = scene(tmp_path)
    old, binary = _source_chunks(source)
    baked = bake_static_furniture_glb(source, manifest, [_placement(AFFINE)])
    regenerated, out_bin = _source_chunks(baked.glb)
    assert baked.source_sha256 == manifest["scene"]["assetSha256"]
    assert baked.baked_sha256 == hashlib.sha256(baked.glb).hexdigest()
    assert baked.canonical_ids == ("chair",)
    assert baked.triangles == 1
    assert source == (tmp_path / "scene.glb").read_bytes()
    assert binary == out_bin[: len(binary)]
    assert len(old["images"]) == len(regenerated["images"]) == 1
    assert len(old["textures"]) == len(regenerated["textures"]) == 1
    for name in ("materials", "images", "textures", "samplers"):
        assert old[name] == regenerated[name]
    texture_view = old["bufferViews"][old["images"][0]["bufferView"]]
    pos = texture_view["byteOffset"]
    assert binary[pos : pos + texture_view["byteLength"]] == (tmp_path / "texture.png").read_bytes()
    assert old["nodes"][0]["extras"] == regenerated["nodes"][0]["extras"]
    assert old["nodes"][1] == regenerated["nodes"][1]
    assert old["meshes"][1] == regenerated["meshes"][1]
    assert regenerated["nodes"][0]["mesh"] != regenerated["nodes"][1]["mesh"]

    src = old["meshes"][0]["primitives"][0]
    new = regenerated["meshes"][regenerated["nodes"][0]["mesh"]]["primitives"][0]
    assert src["material"] == new["material"]
    assert src["attributes"]["TEXCOORD_0"] == new["attributes"]["TEXCOORD_0"]
    assert src["indices"] == new["indices"]
    assert np.array_equal(
        _values(old, binary, src["attributes"]["TEXCOORD_0"]),
        _values(regenerated, out_bin, new["attributes"]["TEXCOORD_0"]),
    )
    source_points = _values(old, binary, src["attributes"]["POSITION"])
    derived_points = _values(regenerated, out_bin, new["attributes"]["POSITION"])
    # IFC (x, y, z) -> glTF (x, z, -y).
    # Source glTF [1,0,0] -> canonical [1,0,0] -> [3.5,-0.5,0.5]
    # -> glTF [3.5,0.5,0.5].
    assert derived_points[1] == pytest.approx([3.5, 0.5, 0.5])
    assert not np.array_equal(source_points, derived_points)
    expected = np.asarray(old["nodes"][1]["mesh"])
    assert expected == 1
    normals = _values(regenerated, out_bin, new["attributes"]["NORMAL"])
    assert np.linalg.norm(normals, axis=1) == pytest.approx([1, 1, 1])
    edge1 = derived_points[1] - derived_points[0]
    edge2 = derived_points[2] - derived_points[0]
    assert np.dot(normals[0], edge1) == pytest.approx(0, abs=1e-6)
    assert np.dot(normals[0], edge2) == pytest.approx(0, abs=1e-6)
    assert bake_static_furniture_glb(source, manifest, [_placement(AFFINE)]).glb == baked.glb


def test_each_target_owns_a_separate_derived_mesh_without_duplicating_source_material(tmp_path):
    source, manifest = scene(tmp_path)
    placements = [_placement(AFFINE), _placement(IDENTITY, identity="table", guid=TABLE_GUID)]
    result = bake_static_furniture_glb(source, manifest, placements)
    doc, _ = _source_chunks(result.glb)
    assert result.triangles == 2
    assert result.canonical_ids == ("chair", "table")
    assert len(doc["materials"]) == 1
    assert doc["nodes"][0]["mesh"] != doc["nodes"][1]["mesh"]


def test_rejects_stale_hash_bad_identity_and_unsupported_static_geometry(tmp_path):
    source, manifest = scene(tmp_path)
    stale = copy.deepcopy(manifest)
    stale["scene"]["assetSha256"] = "0" * 64
    with pytest.raises(WebSceneExportError, match="hash"):
        bake_static_furniture_glb(source, stale, [_placement(AFFINE)])

    for placements in (
        [_placement(AFFINE), _placement(AFFINE)],
        [_placement(AFFINE, identity="unknown")],
        [_placement(AFFINE[:-1])],
        [_placement([*IDENTITY[:10], -1, *IDENTITY[11:]])],
        [_placement([0] * 16)],
        [],
    ):
        with pytest.raises(WebSceneExportError):
            bake_static_furniture_glb(source, manifest, placements)

    # Rejected edits must not change original file bytes.
    assert source == (tmp_path / "scene.glb").read_bytes()


def test_parented_cross_identity_geometry_is_rebaked_in_its_local_frame(tmp_path):
    source, manifest = scene(tmp_path)
    doc, bin_data = _source_chunks(source)
    # The chair and unrelated table share a transformed parent. Rebaking must
    # preserve parent transforms and move only the chair's triangle vertices.
    q = np.sin(np.pi / 4)
    parent = {
        "name": "shared-parent",
        "translation": [1, 2, 3],
        "rotation": [0, 0, q, q],
        "children": [0, 1],
    }
    doc["nodes"].append(parent)
    doc["scenes"][0]["nodes"] = [2]
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    body = struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    body += struct.pack("<II", len(bin_data), 0x004E4942) + bin_data
    original = struct.pack("<4sII", b"glTF", 2, len(body) + 12) + body
    manifest["scene"]["assetSha256"] = hashlib.sha256(original).hexdigest()
    result = bake_static_furniture_glb(original, manifest, [_placement(AFFINE)])
    output, binary = _source_chunks(result.glb)
    assert output["nodes"][2] == parent
    assert output["nodes"][1] == doc["nodes"][1]
    assert output["meshes"][1] == doc["meshes"][1]
    before = _values(doc, bin_data, doc["meshes"][0]["primitives"][0]["attributes"]["POSITION"])
    after = _values(
        output,
        binary,
        output["meshes"][output["nodes"][0]["mesh"]]["primitives"][0]["attributes"]["POSITION"],
    )
    frame = np.eye(4)
    frame[:3, :3] = [
        [0, -1, 0],
        [1, 0, 0],
        [0, 0, 1],
    ]
    frame[:3, 3] = [1, 2, 3]
    canonical_to_scene = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]])
    delta = np.asarray(AFFINE).reshape(4, 4, order="F")
    delta_scene = canonical_to_scene @ delta @ np.linalg.inv(canonical_to_scene)
    for old, new in zip(before, after, strict=True):
        source_world = frame @ np.array([*old, 1])
        expected_world = delta_scene @ source_world
        actual_world = frame @ np.array([*new, 1])
        assert actual_world == pytest.approx(expected_world, abs=2e-6)


def test_rejects_parented_mesh_animations_and_broken_accessors(tmp_path):
    source, manifest = scene(tmp_path)
    old, binary = _source_chunks(source)

    def mutate(mutator):
        doc = copy.deepcopy(old)
        mutator(doc)
        encoded = json.dumps(doc, separators=(",", ":")).encode()
        encoded += b" " * (-len(encoded) % 4)
        padded_bin = binary + b"\0" * (-len(binary) % 4)
        body = struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
        body += struct.pack("<II", len(padded_bin), 0x004E4942) + padded_bin
        mutated = struct.pack("<4sII", b"glTF", 2, len(body) + 12) + body
        derived = copy.deepcopy(manifest)
        derived["scene"]["assetSha256"] = hashlib.sha256(mutated).hexdigest()
        return mutated, derived

    bad_cases = (
        lambda d: d["nodes"][0].update(children=[0]),
        lambda d: d["nodes"][0].update(matrix=[1] * 16, translation=[1, 0, 0]),
        lambda d: d["nodes"][0].update(scale=[-1, 1, 1]),
        lambda d: d.update(animations=[{"channels": [], "samplers": []}]),
        lambda d: d["meshes"][0]["primitives"][0].update(mode=1),
        lambda d: d["accessors"][0].update(sparse={"count": 1}),
        lambda d: d["accessors"][0].update(componentType=5123),
        lambda d: d["meshes"][0]["primitives"][0].update(targets=[{}]),
    )
    for case in bad_cases:
        payload, attached = mutate(case)
        with pytest.raises(WebSceneExportError):
            bake_static_furniture_glb(payload, attached, [_placement(AFFINE)])
