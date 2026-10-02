from __future__ import annotations

from pathlib import Path

import ifcopenshell.util.element
import ifcopenshell.util.placement
import pytest
from teldra_ifc import open_model, resolve_global_id, write_model
from teldra_import_sh3d import (
    Sh3dIfcMappingError,
    import_home_to_ifc,
    source_to_canonical,
    source_yaw_to_canonical,
)
from teldra_sh3d import parse_home_xml

FIXTURE = Path(__file__).parents[4] / "fixtures" / "sh3d" / "golden-home" / "Home.xml"


def test_source_frame_conversion_preserves_right_handed_z_up_space() -> None:
    assert source_to_canonical(1.0, 2.0, 3.0) == (1.0, -2.0, 3.0)
    assert source_yaw_to_canonical(0.5) == pytest.approx(-0.5)


def test_golden_home_maps_to_semantic_ifc4_with_provenance() -> None:
    home = parse_home_xml(FIXTURE.read_bytes())
    result = import_home_to_ifc(home)

    assert result.model.schema == "IFC4"
    assert len(result.model.by_type("IfcBuildingStorey")) == 1
    assert len(result.model.by_type("IfcSpace")) == 1
    assert len(result.model.by_type("IfcWall")) == 4
    assert len(result.model.by_type("IfcFurniture")) == 1
    assert len(result.model.by_type("IfcLightFixture")) == 1
    assert len(result.model.by_type("IfcBuildingElementProxy")) == 1
    assert len(result.model.by_type("IfcOpeningElement")) == 1
    assert len(result.cameras) == 1
    assert result.warnings == ()

    expected_keys = {
        "level:level0",
        "wall:wall0",
        "wall:wall1",
        "wall:wall2",
        "wall:wall3",
        "room:room0",
        "pieceOfFurniture:chair0",
        "doorOrWindow:door0",
        "light:light0",
    }
    assert set(result.source_to_global_id) == expected_keys

    wall0 = resolve_global_id(result.model, result.source_to_global_id["wall:wall0"])
    wall1 = resolve_global_id(result.model, result.source_to_global_id["wall:wall1"])
    chair = resolve_global_id(
        result.model,
        result.source_to_global_id["pieceOfFurniture:chair0"],
    )
    door_proxy = resolve_global_id(
        result.model,
        result.source_to_global_id["doorOrWindow:door0"],
    )

    assert wall0.Representation is not None
    assert wall1.Representation is not None
    assert door_proxy.is_a("IfcBuildingElementProxy")
    assert door_proxy.ObjectType == "Sweet Home 3D DoorOrWindow"

    assert len(door_proxy.FillsVoids) == 1
    opening = door_proxy.FillsVoids[0].RelatingOpeningElement
    assert opening.is_a("IfcOpeningElement")
    assert len(opening.VoidsElements) == 1
    assert opening.VoidsElements[0].RelatingBuildingElement == wall0

    psets = ifcopenshell.util.element.get_psets(wall0)
    assert psets["Teldra_Source"]["SourceKey"] == "wall:wall0"
    assert psets["Teldra_Source"]["SourceSystem"] == "Sweet Home 3D"
    assert psets["Teldra_Source"]["ImportTransform"] == "X=x;Y=-y;Z=elevation"

    wall1_matrix = ifcopenshell.util.placement.get_local_placement(wall1.ObjectPlacement)
    assert wall1_matrix[0][3] == pytest.approx(5.0)
    assert wall1_matrix[1][3] == pytest.approx(0.0)
    assert wall1_matrix[0][0] == pytest.approx(0.0)
    assert wall1_matrix[1][0] == pytest.approx(-1.0)

    chair_matrix = ifcopenshell.util.placement.get_local_placement(chair.ObjectPlacement)
    assert chair_matrix[0][3] == pytest.approx(1.0)
    assert chair_matrix[1][3] == pytest.approx(-1.0)
    assert chair_matrix[2][3] == pytest.approx(0.0)


def test_import_provenance_survives_ifc_write_and_reload(tmp_path) -> None:
    home = parse_home_xml(FIXTURE.read_bytes())
    result = import_home_to_ifc(home)
    wall_id = result.source_to_global_id["wall:wall0"]

    destination = write_model(result.model, tmp_path / "golden-home.ifc")
    reloaded = open_model(destination)
    wall = resolve_global_id(reloaded, wall_id, expected_class="IfcWall")

    assert ifcopenshell.util.element.get_psets(wall)["Teldra_Source"]["SourceKey"] == "wall:wall0"


def test_unknown_level_reference_is_rejected_instead_of_relocated() -> None:
    home = parse_home_xml(
        b"""<home wallHeight='250'>
        <level id='level0' name='Ground' elevation='0' floorThickness='12' height='250'/>
        <wall id='wall0' level='missing' xStart='0' yStart='0'
              xEnd='100' yEnd='0' thickness='10' height='250'/>
        </home>"""
    )

    with pytest.raises(Sh3dIfcMappingError, match="unknown SH3D level"):
        import_home_to_ifc(home)


def test_ambiguous_bound_door_window_is_not_attached_by_guessing() -> None:
    home = parse_home_xml(
        b"""<home wallHeight='250'>
        <level id='level0' name='Ground' elevation='0' floorThickness='12' height='250'/>
        <doorOrWindow id='opening0' name='Opening' level='level0'
              x='250' y='0' elevation='0' width='90' depth='15' height='210'
              angle='0' wallThickness='1' wallDistance='0' wallWidth='1'
              wallLeft='0' wallHeight='1' wallTop='0' boundToWall='true'/>
        <wall id='wall0' level='level0' xStart='0' yStart='0'
              xEnd='500' yEnd='0' thickness='7.5' height='250'/>
        <wall id='wall1' level='level0' xStart='0' yStart='0'
              xEnd='500' yEnd='0' thickness='7.5' height='250'/>
        </home>"""
    )

    result = import_home_to_ifc(home)
    proxy = resolve_global_id(
        result.model,
        result.source_to_global_id["doorOrWindow:opening0"],
    )

    assert proxy.is_a("IfcBuildingElementProxy")
    assert len(result.model.by_type("IfcOpeningElement")) == 0
    assert proxy.FillsVoids == ()
    assert result.warnings == (
        "doorOrWindow:opening0: wall binding matched 2 candidate host walls; "
        "opening relation was not created.",
    )
