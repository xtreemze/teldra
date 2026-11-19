"""Deterministic BIM-quality checks for the SH3D -> IFC import (issue #160).

Each test states one invariant on a small inline SH3D home so the IFC graph can
be reasoned about by hand. All geometry is evaluated with IfcOpenShell itself,
not with importer-side bookkeeping.
"""

from __future__ import annotations

import math
from collections import Counter
from pathlib import Path

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.placement
import ifcopenshell.util.shape
import ifcopenshell.validate
import numpy as np
import pytest
from teldra_ifc import open_model, write_model
from teldra_import_sh3d import import_home_to_ifc
from teldra_sh3d import parse_home_xml

GOLDEN = Path(__file__).parents[4] / "fixtures" / "sh3d" / "golden-home" / "Home.xml"

LEVELS = """
<level id='L0' name='Ground' elevation='0' floorThickness='12' height='250' elevationIndex='0'/>
<level id='L1' name='First' elevation='262' floorThickness='12' height='250' elevationIndex='1'/>
"""

# Ground floor: a closed 5 x 4 m loop (SH3D y grows downwards) plus a free wall.
# First floor: one wall carrying a window; checks per-level elevation handling.
HOME = f"""<home version='7500' name='BIM Home' wallHeight='250'>
{LEVELS}
<doorOrWindow id='door0' name='Front door' level='L0' x='250' y='0' elevation='0'
  width='90' depth='15' height='210' angle='0' wallThickness='1' wallDistance='0'
  wallWidth='1' wallLeft='0' wallHeight='1' wallTop='0' boundToWall='true'/>
<doorOrWindow id='win0' name='Kitchen window' level='L0' x='250' y='400' elevation='90'
  width='100' depth='15' height='100' angle='3.14159265358979' wallThickness='1'
  wallDistance='0' wallWidth='1' wallLeft='0' wallHeight='1' wallTop='0'
  boundToWall='true'/>
<doorOrWindow id='lost0' name='Floating door' level='L0' x='900' y='900' elevation='0'
  width='90' depth='15' height='210' angle='0' wallThickness='1' wallDistance='0'
  wallWidth='1' wallLeft='0' wallHeight='1' wallTop='0' boundToWall='true'/>
<doorOrWindow id='free0' name='Unbound door' level='L0' x='100' y='0' elevation='0'
  width='90' depth='15' height='210' angle='0' boundToWall='false'/>
<doorOrWindow id='upwin' name='Upper window' level='L1' x='200' y='0' elevation='90'
  width='80' depth='15' height='100' angle='0' wallThickness='1' wallDistance='0'
  wallWidth='1' wallLeft='0' wallHeight='1' wallTop='0' boundToWall='true'/>
<wall id='w0' level='L0' wallAtStart='w3' wallAtEnd='w1'
  xStart='0' yStart='0' xEnd='500' yEnd='0' height='250' thickness='7.5'/>
<wall id='w1' level='L0' wallAtStart='w0' wallAtEnd='w2'
  xStart='500' yStart='0' xEnd='500' yEnd='400' height='250' thickness='7.5'/>
<wall id='w2' level='L0' wallAtStart='w1' wallAtEnd='w3'
  xStart='500' yStart='400' xEnd='0' yEnd='400' height='250' thickness='7.5'/>
<wall id='w3' level='L0' wallAtStart='w2' wallAtEnd='w0'
  xStart='0' yStart='400' xEnd='0' yEnd='0' height='250' thickness='7.5'/>
<wall id='stray' level='L0' wallAtStart='missing'
  xStart='600' yStart='0' xEnd='700' yEnd='0' height='250' thickness='10'/>
<wall id='far' level='L0' wallAtEnd='w1'
  xStart='800' yStart='0' xEnd='900' yEnd='0' height='250' thickness='10'/>
<wall id='up0' level='L1' xStart='0' yStart='0' xEnd='400' yEnd='0'
  height='250' thickness='10'/>
<room id='room0' level='L0' name='Hall'>
  <point x='3.75' y='3.75'/><point x='496.25' y='3.75'/>
  <point x='496.25' y='396.25'/><point x='3.75' y='396.25'/>
</room>
<room id='line0' level='L0' name='Degenerate'>
  <point x='0' y='0'/><point x='10' y='10'/>
</room>
</home>"""


def _import(xml: str = HOME, **kwargs):
    return import_home_to_ifc(parse_home_xml(xml), **kwargs)


def _entity(result, key: str):
    return result.model.by_guid(result.source_to_global_id[key])


class _Collector:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def error(self, message="", *args, **kwargs) -> None:
        self.errors.append(str(message))

    def warning(self, *args, **kwargs) -> None: ...
    def info(self, *args, **kwargs) -> None: ...
    def debug(self, *args, **kwargs) -> None: ...
    def log(self, *args, **kwargs) -> None: ...


def express_errors(model: ifcopenshell.file) -> list[str]:
    collector = _Collector()
    ifcopenshell.validate.validate(model, collector, express_rules=True)
    return collector.errors


def _volume(element, *, with_openings: bool) -> float:
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    settings.set("disable-opening-subtractions", not with_openings)
    shape = ifcopenshell.geom.create_shape(settings, element)
    return float(ifcopenshell.util.shape.get_volume(shape.geometry))


def _bbox(element) -> tuple[np.ndarray, np.ndarray]:
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    shape = ifcopenshell.geom.create_shape(settings, element)
    vertices = ifcopenshell.util.shape.get_vertices(shape.geometry)
    return vertices.min(axis=0), vertices.max(axis=0)


def _world(entity) -> np.ndarray:
    return np.asarray(ifcopenshell.util.placement.get_local_placement(entity.ObjectPlacement))


def _axis_endpoints(wall) -> tuple[np.ndarray, np.ndarray]:
    axis = next(
        r for r in wall.Representation.Representations if r.RepresentationIdentifier == "Axis"
    )
    points = axis.Items[0].Points.CoordList
    matrix = _world(wall)
    return tuple(  # type: ignore[return-value]
        (matrix @ np.array([*points[index], 0.0, 1.0]))[:3] for index in (0, -1)
    )


# --------------------------------------------------------------------------- validity


def test_import_is_express_valid_for_golden_and_multi_level_homes() -> None:
    assert express_errors(_import(GOLDEN.read_text()).model) == []
    assert express_errors(_import().model) == []


# ---------------------------------------------------------------- doors, windows, openings


def test_doors_and_windows_are_typed_not_proxies() -> None:
    result = _import()
    assert _entity(result, "doorOrWindow:door0").is_a("IfcDoor")
    assert _entity(result, "doorOrWindow:win0").is_a("IfcWindow")
    assert _entity(result, "doorOrWindow:upwin").is_a("IfcWindow")
    assert result.model.by_type("IfcBuildingElementProxy") == ()
    door = _entity(result, "doorOrWindow:door0")
    assert door.OverallWidth == pytest.approx(0.9)
    assert door.OverallHeight == pytest.approx(2.1)
    # SH3D provenance stays on the typed element and remains the source-id owner.
    psets = ifcopenshell.util.element.get_psets(door)
    assert psets["Teldra_Source"]["SourceKey"] == "doorOrWindow:door0"


def test_hosted_openings_have_body_void_fill_and_wall_relative_placement() -> None:
    result = _import()
    model = result.model
    # door0, win0 (L0) and upwin (L1) are hostable; lost0 and free0 are not.
    assert len(model.by_type("IfcOpeningElement")) == 3
    assert len(model.by_type("IfcRelVoidsElement")) == 3
    assert len(model.by_type("IfcRelFillsElement")) == 3

    expectations = {
        "doorOrWindow:door0": "wall:w0",
        "doorOrWindow:win0": "wall:w2",
        "doorOrWindow:upwin": "wall:up0",
    }
    for door_key, wall_key in expectations.items():
        filling = _entity(result, door_key)
        wall = _entity(result, wall_key)
        assert len(filling.FillsVoids) == 1
        opening = filling.FillsVoids[0].RelatingOpeningElement
        assert opening.is_a("IfcOpeningElement")
        assert opening.PredefinedType == "OPENING"
        assert opening.VoidsElements[0].RelatingBuildingElement == wall
        assert [r.RepresentationIdentifier for r in opening.Representation.Representations] == [
            "Body"
        ]
        body = opening.Representation.Representations[0]
        assert body.RepresentationType == "SweptSolid"
        assert body.Items[0].is_a("IfcExtrudedAreaSolid")
        # Opening is placed in the host wall's frame; the filling in the opening's frame.
        assert opening.ObjectPlacement.PlacementRelTo == wall.ObjectPlacement
        assert filling.ObjectPlacement.PlacementRelTo == opening.ObjectPlacement


def test_filling_keeps_source_pose_and_opening_carries_with_wall() -> None:
    result = _import()
    door = _entity(result, "doorOrWindow:door0")
    matrix = _world(door)
    assert tuple(matrix[:3, 3]) == pytest.approx((2.5, 0.0, 0.0))

    window = _entity(result, "doorOrWindow:win0")
    matrix = _world(window)
    assert tuple(matrix[:3, 3]) == pytest.approx((2.5, -4.0, 0.9))
    # SH3D yaw pi -> canonical yaw -pi (a half turn either way).
    assert abs(matrix[0, 0]) == pytest.approx(1.0)
    assert matrix[0, 0] == pytest.approx(-1.0, abs=1e-9)

    # Moving the host wall carries opening and (via the opening) the filling.
    wall = _entity(result, "wall:w0")
    opening = door.FillsVoids[0].RelatingOpeningElement
    before = _world(opening)[:3, 3].copy()
    placement = wall.ObjectPlacement.RelativePlacement.Location
    placement.Coordinates = (placement.Coordinates[0] + 1.0, *placement.Coordinates[1:])
    assert (_world(opening)[:3, 3] - before) == pytest.approx((1.0, 0.0, 0.0))
    assert _world(door)[0, 3] == pytest.approx(3.5)


def test_wall_volume_with_void_is_smaller_by_the_opening_cut() -> None:
    result = _import()
    wall = _entity(result, "wall:w0")
    solid = _volume(wall, with_openings=False)
    voided = _volume(wall, with_openings=True)
    assert solid == pytest.approx(5.0 * 0.075 * 2.5)
    assert voided < solid
    assert solid - voided == pytest.approx(0.9 * 0.075 * 2.1, rel=1e-6)

    window_wall = _entity(result, "wall:w2")
    cut = _volume(window_wall, with_openings=False) - _volume(window_wall, with_openings=True)
    assert cut == pytest.approx(1.0 * 0.075 * 1.0, rel=1e-6)

    upper = _entity(result, "wall:up0")
    cut = _volume(upper, with_openings=False) - _volume(upper, with_openings=True)
    assert cut == pytest.approx(0.8 * 0.1 * 1.0, rel=1e-6)


def test_upper_level_elements_are_placed_at_the_level_elevation() -> None:
    result = _import()
    wall = _entity(result, "wall:up0")
    low, high = _bbox(wall)
    assert low[2] == pytest.approx(2.62)
    assert high[2] == pytest.approx(5.12)
    window = _entity(result, "doorOrWindow:upwin")
    assert _world(window)[2, 3] == pytest.approx(2.62 + 0.9)
    opening = window.FillsVoids[0].RelatingOpeningElement
    opening_low, opening_high = _bbox(opening)
    assert opening_low[2] == pytest.approx(2.62 + 0.9)
    assert opening_high[2] == pytest.approx(2.62 + 1.9)


def test_unhostable_doors_stay_typed_unhosted_and_are_reported() -> None:
    result = _import()
    lost = _entity(result, "doorOrWindow:lost0")
    free = _entity(result, "doorOrWindow:free0")
    assert lost.is_a("IfcDoor") and free.is_a("IfcDoor")
    assert lost.FillsVoids == () and free.FillsVoids == ()
    assert any(
        "doorOrWindow:lost0" in warning and "0 candidate" in warning for warning in result.warnings
    )
    assert any(
        "doorOrWindow:free0" in warning and "not bound" in warning for warning in result.warnings
    )
    summary = result.bim_summary
    assert summary["doorsAndWindows"] == 5
    assert summary["hostedDoorsAndWindows"] == 3
    assert sorted(item["sourceKey"] for item in summary["unhostedDoorsAndWindows"]) == [
        "doorOrWindow:free0",
        "doorOrWindow:lost0",
    ]


# --------------------------------------------------------------------------- walls


def test_walls_have_axis_material_layers_and_stay_regenerable() -> None:
    result = _import()
    wall = _entity(result, "wall:stray")  # isolated: regeneration must reproduce the body
    identifiers = sorted(r.RepresentationIdentifier for r in wall.Representation.Representations)
    assert identifiers == ["Axis", "Body"]
    usage = ifcopenshell.util.element.get_material(wall)
    assert usage.is_a("IfcMaterialLayerSetUsage")
    assert sum(layer.LayerThickness for layer in usage.ForLayerSet.MaterialLayers) == pytest.approx(
        0.1
    )

    start, end = _axis_endpoints(wall)
    assert tuple(start[:2]) == pytest.approx((6.0, 0.0))
    assert tuple(end[:2]) == pytest.approx((7.0, 0.0))

    before = _bbox(wall)
    copy = ifcopenshell.file.from_string(result.model.to_string())
    twin = copy.by_guid(wall.GlobalId)
    ifcopenshell.api.run(
        "geometry.regenerate_wall_representation", copy, wall=twin, length=1.0, height=2.5
    )
    after = _bbox(twin)
    assert after[0] == pytest.approx(before[0])
    assert after[1] == pytest.approx(before[1])


def test_connected_sh3d_walls_get_path_connections_and_unresolvable_links_are_reported() -> None:
    result = _import()
    relations = result.model.by_type("IfcRelConnectsPathElements")
    # w0-w1, w1-w2, w2-w3, w3-w0 corners; 'stray' (missing wall) and 'far'
    # (links to w1 but not at its end) are not resolvable.
    assert len(relations) == 4
    assert result.bim_summary["pathConnections"] == 4
    assert result.bim_summary["unresolvedWallLinks"] == 2

    for relation in relations:
        a_points = _axis_endpoints(relation.RelatingElement)
        b_points = _axis_endpoints(relation.RelatedElement)
        a_end = a_points[1] if relation.RelatingConnectionType == "ATEND" else a_points[0]
        b_end = b_points[1] if relation.RelatedConnectionType == "ATEND" else b_points[0]
        assert a_end == pytest.approx(b_end)
    pairs = {
        frozenset(
            (
                relation.RelatingElement.Name,
                relation.RelatedElement.Name,
            )
        )
        for relation in relations
    }
    assert pairs == {
        frozenset(("wall:w0", "wall:w1")),
        frozenset(("wall:w1", "wall:w2")),
        frozenset(("wall:w2", "wall:w3")),
        frozenset(("wall:w3", "wall:w0")),
    }
    assert any("wall:stray" in w and "missing" in w for w in result.warnings)
    assert any("wall:far" in w for w in result.warnings)


# --------------------------------------------------------------------------- spaces


def test_rooms_become_spaces_with_placement_footprint_and_body() -> None:
    result = _import()
    space = _entity(result, "room:room0")
    storey = _entity(result, "level:L0")
    assert space.is_a("IfcSpace")
    assert space.ObjectPlacement is not None
    assert space.ObjectPlacement.PlacementRelTo == storey.ObjectPlacement
    kinds = {
        r.RepresentationIdentifier: r.RepresentationType
        for r in space.Representation.Representations
    }
    assert kinds == {"Body": "SweptSolid", "FootPrint": "Curve2D"}

    low, high = _bbox(space)
    assert tuple(low) == pytest.approx((0.0375, -3.9625, 0.0))
    assert tuple(high) == pytest.approx((4.9625, -0.0375, 2.5))
    settings = ifcopenshell.geom.settings()
    shape = ifcopenshell.geom.create_shape(settings, space)
    assert ifcopenshell.util.shape.get_volume(shape.geometry) == pytest.approx(4.925 * 3.925 * 2.5)
    # Counter-clockwise footprint despite the SH3D -> canonical Y flip.
    footprint = next(
        r for r in space.Representation.Representations if r.RepresentationIdentifier == "FootPrint"
    )
    ring = [tuple(point.Coordinates) for point in footprint.Items[0].Points]
    assert ring[0] == ring[-1] and len(ring) == 5
    twice_area = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:], strict=False))
    assert twice_area / 2 == pytest.approx(4.925 * 3.925)

    upper_storey_space = _import(
        HOME.replace(
            "<room id='line0'",
            "<room id='up' level='L1' name='Up'><point x='0' y='0'/><point x='100' y='0'/>"
            "<point x='100' y='100'/></room><room id='line0'",
        )
    )
    up = _entity(upper_storey_space, "room:up")
    assert _bbox(up)[0][2] == pytest.approx(2.62)


def test_degenerate_room_keeps_identity_but_is_reported() -> None:
    result = _import()
    degenerate = _entity(result, "room:line0")
    assert degenerate.is_a("IfcSpace")
    assert degenerate.Representation is None
    assert any("room:line0" in warning for warning in result.warnings)
    assert result.bim_summary["spaces"] == 2
    assert result.bim_summary["spacesWithBody"] == 1


# --------------------------------------------------------------------------- identity


def _identity_snapshot(model: ifcopenshell.file) -> dict[str, tuple[str, str | None]]:
    return {
        entity.GlobalId: (entity.is_a(), entity.Name)
        for entity in model.by_type("IfcRoot")
        if not entity.is_a("IfcRelationship")
    }


def test_reimport_preserves_every_rooted_global_id(tmp_path) -> None:
    first = _import()
    existing = open_model(write_model(first.model, tmp_path / "first.ifc"))
    second = _import(existing_model=existing)

    assert dict(second.source_to_global_id) == dict(first.source_to_global_id)
    # Includes derived hosted openings: not only SH3D-source-owned elements.
    assert _identity_snapshot(second.model) == _identity_snapshot(first.model)
    assert len(_identity_snapshot(first.model)) > len(first.source_to_global_id)

    # Relationships survive too: same void / fill / path edges.
    def edges(model):
        return {
            *(
                (r.RelatingBuildingElement.GlobalId, r.RelatedOpeningElement.GlobalId)
                for r in model.by_type("IfcRelVoidsElement")
            ),
            *(
                (r.RelatingOpeningElement.GlobalId, r.RelatedBuildingElement.GlobalId)
                for r in model.by_type("IfcRelFillsElement")
            ),
            *(
                (
                    r.RelatingElement.GlobalId,
                    r.RelatedElement.GlobalId,
                    r.RelatingConnectionType,
                    r.RelatedConnectionType,
                )
                for r in model.by_type("IfcRelConnectsPathElements")
            ),
        }

    assert edges(second.model) == edges(first.model)


def test_reimport_after_source_edit_keeps_unchanged_ids_and_hosting(tmp_path) -> None:
    first = _import()
    existing = open_model(write_model(first.model, tmp_path / "first.ifc"))
    edited = HOME.replace(
        "xStart='600' yStart='0' xEnd='700' yEnd='0'", "xStart='600' yStart='0' xEnd='750' yEnd='0'"
    )
    second = _import(edited, existing_model=existing)
    assert dict(second.source_to_global_id) == dict(first.source_to_global_id)
    assert _entity(second, "doorOrWindow:door0").FillsVoids[0].RelatingOpeningElement.GlobalId == (
        _entity(first, "doorOrWindow:door0").FillsVoids[0].RelatingOpeningElement.GlobalId
    )
    assert _identity_snapshot(second.model) == _identity_snapshot(first.model)


def test_legacy_proxy_identity_is_adopted_by_the_typed_door() -> None:
    """A pre-#160 import carried doors as proxies; their GlobalIds must survive."""
    legacy = _import()
    door = _entity(legacy, "doorOrWindow:door0")
    original_id = door.GlobalId
    ifcopenshell.api.run(
        "root.reassign_class", legacy.model, product=door, ifc_class="IfcBuildingElementProxy"
    )
    assert legacy.model.by_guid(original_id).is_a("IfcBuildingElementProxy")
    again = _import(existing_model=legacy.model)
    assert again.source_to_global_id["doorOrWindow:door0"] == original_id
    assert again.model.by_guid(original_id).is_a("IfcDoor")


# --------------------------------------------------------------------------- loss report


def test_loss_report_lists_unmapped_sh3d_attributes_and_elements() -> None:
    xml = f"""<home version='7500' name='Lossy' wallHeight='250' camera='topCamera'>
{LEVELS}
<compass x='1' y='2' diameter='100' northDirection='0' latitude='0.7' longitude='0.1'/>
<doorOrWindow id='d' name='Door' level='L0' catalogId='eTeks#door' x='250' y='0'
  elevation='0' width='90' depth='15' height='210' angle='0' boundToWall='true'
  creator='x' wallThickness='1' wallDistance='0' wallWidth='1' wallLeft='0'
  wallHeight='1' wallTop='0'>
  <sash xAxis='1' yAxis='2' width='0.5' startAngle='0' endAngle='1.5'/>
  <texture name='tex' image='1'/>
</doorOrWindow>
<furnitureGroup id='g' name='Group' level='L0' x='0' y='0' width='1' depth='1' height='1'>
  <pieceOfFurniture id='p' name='P' level='L0' catalogId='cat' x='1' y='1' width='1'
    depth='1' height='1' angle='0'/>
</furnitureGroup>
<wall id='w' level='L0' xStart='0' yStart='0' xEnd='100' yEnd='0' height='250'
  thickness='10' pattern='hatchUp' leftSideColor='ff00ff00'>
  <baseboard thickness='1' height='7'/>
</wall>
<label id='l' level='L0' x='0' y='0' text='hi'/>
</home>"""
    result = import_home_to_ifc(parse_home_xml(xml))
    loss = {(entry["path"], entry["kind"]): entry["count"] for entry in result.loss_report}
    assert loss[("doorOrWindow@catalogId", "attribute")] == 1
    assert loss[("pieceOfFurniture@catalogId", "attribute")] == 1
    assert loss[("doorOrWindow@creator", "attribute")] == 1
    assert loss[("wall@pattern", "attribute")] == 1
    assert loss[("wall@leftSideColor", "attribute")] == 1
    assert loss[("home@camera", "attribute")] == 1
    for tag in ("baseboard", "sash", "texture", "furnitureGroup", "label", "compass"):
        assert loss[(tag, "element")] >= 1, tag
    home = parse_home_xml(xml)
    assert {"baseboard", "sash", "texture", "furnitureGroup", "label", "compass"} <= set(
        home.unsupported_elements
    )
    # Modelled attributes are not reported as losses.
    assert ("wall@thickness", "attribute") not in loss
    assert ("doorOrWindow@width", "attribute") not in loss


def test_golden_home_inventory_has_no_unclassified_tags_or_attributes() -> None:
    """Contract: nothing silent. Anything unmodelled shows in the loss report."""
    home = parse_home_xml(GOLDEN.read_bytes())
    unclassified = {(e.path, e.kind) for e in home.loss_entries}
    assert unclassified == {("home@camera", "attribute")}
    assert home.unsupported_elements == ()


def test_bim_summary_counts_match_the_ifc_graph() -> None:
    result = _import()
    model = result.model
    summary = result.bim_summary
    assert summary["openingsWithBody"] == sum(
        1 for o in model.by_type("IfcOpeningElement") if o.Representation is not None
    )
    assert summary["pathConnections"] == len(model.by_type("IfcRelConnectsPathElements"))
    assert summary["spaces"] == len(model.by_type("IfcSpace"))
    assert Counter(e.is_a() for e in model.by_type("IfcDoor", include_subtypes=False)) == {
        "IfcDoor": 3
    }
    assert math.isclose(summary["openingsWithBody"], 3)
