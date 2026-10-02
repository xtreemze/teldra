from __future__ import annotations

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from teldra_sh3d import Sh3dFormatError, load_sh3d, parse_home_xml

FIXTURE = (
    Path(__file__).parents[4]
    / "fixtures"
    / "sh3d"
    / "golden-home"
    / "Home.xml"
)


def test_parse_home_xml_normalizes_lengths_to_metres_and_preserves_semantics() -> None:
    home = parse_home_xml(FIXTURE.read_bytes())

    assert home.name == "Golden SH3D Home"
    assert home.version == 7500
    assert home.default_wall_height_m == pytest.approx(2.5)

    assert len(home.levels) == 1
    assert home.levels[0].source.key == "level:level0"
    assert home.levels[0].floor_thickness_m == pytest.approx(0.12)
    assert home.levels[0].height_m == pytest.approx(2.5)
    assert home.levels[0].elevation_index == 0

    assert [piece.kind for piece in home.furniture] == [
        "pieceOfFurniture",
        "doorOrWindow",
        "light",
    ]
    chair, door, light = home.furniture
    assert chair.x_m == pytest.approx(1.0)
    assert chair.width_m == pytest.approx(0.5)
    assert chair.materials[0].name == "Fabric"
    assert chair.materials[0].color == 0xAAAAAA

    assert door.wall_binding is not None
    assert door.wall_binding.bound_to_wall is True
    assert door.width_m == pytest.approx(0.9)

    assert light.power == pytest.approx(0.75)
    assert light.light_sources[0].z_ratio == pytest.approx(0.9)
    assert light.light_sources[0].color == 0xFFFFFF

    assert len(home.walls) == 4
    assert home.walls[0].end.x_m == pytest.approx(5.0)
    assert home.walls[0].thickness_m == pytest.approx(0.075)

    assert len(home.rooms) == 1
    assert len(home.rooms[0].points) == 4
    assert home.rooms[0].points[2].x_m == pytest.approx(4.9625)
    assert home.rooms[0].points[2].y_m == pytest.approx(3.9625)

    assert len(home.cameras) == 1
    assert home.cameras[0].yaw_rad == pytest.approx(0.5)
    assert home.cameras[0].field_of_view_rad == pytest.approx(1.0471975512)
    assert home.unsupported_elements == ()


def test_load_sh3d_reads_only_documented_home_xml_entry(tmp_path) -> None:
    archive = tmp_path / "golden.sh3d"
    with ZipFile(archive, "w", compression=ZIP_DEFLATED) as output:
        output.writestr("Home.xml", FIXTURE.read_bytes())
        output.writestr("Home", b"this Java serialization entry must never be parsed")

    home = load_sh3d(archive)

    assert home.name == "Golden SH3D Home"
    assert home.walls[0].source.source_id == "wall0"


def test_load_sh3d_requires_exactly_one_home_xml(tmp_path) -> None:
    archive = tmp_path / "missing.sh3d"
    with ZipFile(archive, "w") as output:
        output.writestr("Other.xml", "<home/>")

    with pytest.raises(Sh3dFormatError, match="exactly one Home.xml"):
        load_sh3d(archive)


def test_parser_rejects_doctype_and_entity_declarations() -> None:
    payload = b"""<?xml version='1.0'?>
<!DOCTYPE home [<!ENTITY payload 'unexpected'>]>
<home name='&payload;'/>
"""

    with pytest.raises(Sh3dFormatError, match="must not declare"):
        parse_home_xml(payload)


def test_parser_reports_missing_required_numeric_attribute() -> None:
    with pytest.raises(Sh3dFormatError, match='missing required numeric attribute "xEnd"'):
        parse_home_xml(
            b"""<home><wall id='wall0' xStart='0' yStart='0' yEnd='0' thickness='7.5'/></home>"""
        )
