from __future__ import annotations

import hashlib
import io
import runpy
import struct
from pathlib import Path

import pytest
from PIL import Image, ImageCms
from teldra_web_export import read_glb_json
from teldra_web_export.wavefront import _portable_image, export_wavefront_scene

_image = io.BytesIO()
Image.new("RGBA", (1, 1), (255, 0, 0, 255)).save(_image, format="PNG")
PNG = _image.getvalue()
OBJ = """mtllib test.mtl
v 0 0 0
v 100 0 0
v 100 100 0
v 0 100 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
g furniture
usemtl wood
f 1/1/1 2/2/1 3/3/1 4/4/1
g wire
l -4 -3 -2
"""


def fixture(tmp_path: Path) -> Path:
    (tmp_path / "test.obj").write_text(OBJ)
    (tmp_path / "test.mtl").write_text(
        "newmtl wood\nKa 0.1 0.2 0.3\nKd 1 1 1\nKs 0.4 0.4 0.4\n"
        "Ns 60\nd 0.6\nNi 1.5\nillum 2\nmap_Kd wood.png\n"
    )
    (tmp_path / "wood.png").write_bytes(PNG)
    return tmp_path / "test.obj"


def test_geometry_uv_materials_lines_and_original_image_bytes_survive(tmp_path) -> None:
    source = fixture(tmp_path)
    # Lines have no texture coordinates, so give them their own solid material.
    source.write_text(OBJ.replace("g wire\n", "g wire\nusemtl wire\n"))
    with (tmp_path / "test.mtl").open("a") as stream:
        stream.write("newmtl wire\nKd 0 0 0\n")
    glb = tmp_path / "scene.glb"
    result = export_wavefront_scene(source, glb, tmp_path / "scene.json", building_sha256="a" * 64)
    assert result["triangles"] == 2
    assert result["lineSegments"] == 2
    assert result["meshParts"] == 2
    assert result["textures"] == 1
    doc = read_glb_json(glb)
    assert doc["materials"][0]["alphaMode"] == "BLEND"
    original = doc["materials"][0]["extras"]["teldraSourceMaterial"]
    assert original["Ns"] == [60]
    assert original["Ni"] == [1.5]
    assert original["Ka"] == [0.1, 0.2, 0.3]
    payload = glb.read_bytes()
    json_length = struct.unpack_from("<I", payload, 12)[0]
    binary = payload[28 + json_length :]
    image = doc["bufferViews"][doc["images"][0]["bufferView"]]
    assert binary[image["byteOffset"] : image["byteOffset"] + image["byteLength"]] == PNG
    assert next(x for x in result["resources"] if x["path"] == "wood.png")["sha256"] == (
        hashlib.sha256(PNG).hexdigest()
    )
    position = doc["accessors"][0]
    assert position["max"] == [1, 1, 0]
    uv = doc["bufferViews"][doc["accessors"][1]["bufferView"]]
    assert struct.unpack_from("<2f", binary, uv["byteOffset"]) == (0, 1)
    assert doc["nodes"][0]["extras"]["teldra"]["nodeKey"] == "sh3d-visual:part:0"


@pytest.mark.parametrize("bad", ["../outside.png", "https://host/image.png", "C:/private.png"])
def test_material_paths_cannot_escape_the_export_directory(tmp_path, bad) -> None:
    source = fixture(tmp_path)
    material = tmp_path / "test.mtl"
    material.write_text(material.read_text().replace("wood.png", bad))
    with pytest.raises(ValueError):
        export_wavefront_scene(
            source, tmp_path / "out.glb", tmp_path / "scene.json", building_sha256="a" * 64
        )
    assert not (tmp_path / "out.glb").exists()


def test_missing_texture_is_an_error_instead_of_an_untextured_fallback(tmp_path) -> None:
    source = fixture(tmp_path)
    (tmp_path / "wood.png").unlink()
    with pytest.raises(ValueError, match="Missing"):
        export_wavefront_scene(
            source, tmp_path / "out.glb", tmp_path / "scene.json", building_sha256="a" * 64
        )


def test_native_source_tags_bind_render_parts_to_ifc_and_keep_hidden_content(tmp_path) -> None:
    source = fixture(tmp_path)
    source.write_text(OBJ.split("g wire")[0].replace("g furniture", "g teldraHidden_chair_1"))
    glb = tmp_path / "scene.glb"
    result = export_wavefront_scene(
        source,
        glb,
        tmp_path / "scene.json",
        building_sha256="a" * 64,
        source_bindings={"pieceOfFurniture:chair": ("furniture:chair", "1234567890123456789012")},
    )
    assert result["hiddenMeshParts"] == 1
    assert result["mappedVisualParts"] == 1
    assert result["sourceKeysWithVisuals"] == ["pieceOfFurniture:chair"]
    node = read_glb_json(glb)["nodes"][0]
    assert node["extras"]["teldraSourceVisibility"]["hidden"] is True
    assert node["extras"]["teldra"]["ifcGlobalId"] == "1234567890123456789012"


def test_icc_conversion_preserves_dimensions_and_alpha_without_source_profile() -> None:
    source = Image.new("RGBA", (2, 1), (180, 60, 30, 17))
    buffer = io.BytesIO()
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    source.save(buffer, format="PNG", icc_profile=profile)
    converted, changed = _portable_image(buffer.getvalue())
    assert changed
    with Image.open(io.BytesIO(converted)) as image:
        assert image.size == (2, 1)
        assert image.getpixel((0, 0)) == (180, 60, 30, 17)
        assert "icc_profile" not in image.info


def test_opaque_rgba_texture_does_not_force_transparent_render_order(tmp_path) -> None:
    source = fixture(tmp_path)
    source.write_text(OBJ.split("g wire")[0])
    material = tmp_path / "test.mtl"
    material.write_text(material.read_text().replace("d 0.6", "d 1.0"))
    glb = tmp_path / "scene.glb"
    export_wavefront_scene(source, glb, tmp_path / "scene.json", building_sha256="a" * 64)
    assert read_glb_json(glb)["materials"][0]["alphaMode"] == "OPAQUE"


def test_native_culling_is_preserved_without_making_ceilings_double_sided(tmp_path) -> None:
    source = fixture(tmp_path)
    source.write_text(
        OBJ.split("g wire")[0].replace("g furniture", "g teldraVisible_chair_CullNone_1")
    )
    glb = tmp_path / "scene.glb"
    result = export_wavefront_scene(source, glb, tmp_path / "scene.json", building_sha256="a" * 64)
    doc = read_glb_json(glb)
    assert doc["materials"][0]["doubleSided"] is False
    assert doc["materials"][doc["meshes"][0]["primitives"][0]["material"]]["doubleSided"] is True
    assert result["materials"] == 1
    assert result["transportMaterialVariants"] == 1


def test_authored_browser_fixture_matches_the_transport_generator() -> None:
    root = Path(__file__).parents[4]
    generator = runpy.run_path(str(root / "tools/fixtures/generate_sh3d_visual_fixture.py"))
    assert (
        generator["build"]() == (root / "fixtures/sh3d/visual-transport/fixture.json").read_bytes()
    )
