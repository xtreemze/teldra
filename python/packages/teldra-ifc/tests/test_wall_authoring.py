from __future__ import annotations

import ifcopenshell.api.root
import pytest
from teldra_ifc import create_ifc4_home, open_model, write_model
from teldra_ifc.wall_authoring import (
    StraightWall,
    WallAuthoringError,
    create_straight_wall,
    edit_straight_wall,
)


def _fixture():
    model, ids = create_ifc4_home()
    return model, ids.storey


def _straight():
    return StraightWall(start=(0.0, 0.0), end=(4.0, 0.0), thickness_m=0.2, height_m=2.6)


def test_create_wall_uses_canonical_ifc_ownership_and_preserves_source():
    source, storey_guid = _fixture()
    original_bytes = source.to_string()
    old_guids = {item.GlobalId for item in source.by_type("IfcRoot")}

    result, guid = create_straight_wall(source, storey_guid, _straight(), name="Hall wall")

    assert source.to_string() == original_bytes
    assert {item.GlobalId for item in source.by_type("IfcRoot")} == old_guids
    assert guid not in old_guids
    wall = result.by_guid(guid)
    assert wall.is_a("IfcWall")
    assert wall.Name == "Hall wall"
    assert wall.ContainedInStructure[0].RelatingStructure.GlobalId == storey_guid
    assert wall.Representation.Representations[0].RepresentationType == "SweptSolid"
    assert {item.GlobalId for item in result.by_type("IfcRoot")}.issuperset(old_guids)


def test_edit_wall_preserves_guid_and_untouched_source_references(tmp_path):
    model, storey_guid = _fixture()
    model, guid = create_straight_wall(model, storey_guid, _straight())
    before = model.to_string()
    original_guids = {item.GlobalId for item in model.by_type("IfcRoot")}
    modified = edit_straight_wall(
        model,
        guid,
        StraightWall(
            start=(1.0, 2.0),
            end=(6.0, 2.0),
            thickness_m=0.35,
            height_m=3.0,
        ),
    )

    assert model.to_string() == before
    assert modified.by_guid(guid).GlobalId == guid
    assert {item.GlobalId for item in modified.by_type("IfcRoot")} == original_guids
    assert len(modified.by_guid(guid).Representation.Representations) == 1
    reopened = open_model(write_model(modified, tmp_path / "edited-wall.ifc"))
    representation = reopened.by_guid(guid).Representation.Representations[0]
    assert representation.RepresentationType == "SweptSolid"
    containment = reopened.by_guid(guid).ContainedInStructure[0]
    assert containment.RelatingStructure.GlobalId == storey_guid


def test_rejects_degenerate_wall_without_mutating_source():
    model, storey_guid = _fixture()
    before = model.to_string()
    bad = [
        StraightWall((0, 0), (0, 0), 0.2, 2.6),
        StraightWall((0, 0), (float("nan"), 0), 0.2, 2.6),
        StraightWall((0, 0), (4, 0), -0.2, 2.6),
        StraightWall((0, 0), (4, 0), 0.2, float("inf")),
    ]
    for geometry in bad:
        with pytest.raises(WallAuthoringError):
            create_straight_wall(model, storey_guid, geometry)
    assert model.to_string() == before


def test_rejects_hosted_wall_edit_and_preserves_opening_relation():
    model, storey_guid = _fixture()
    model, guid = create_straight_wall(model, storey_guid, _straight())
    wall = model.by_guid(guid)
    opening = ifcopenshell.api.root.create_entity(
        model,
        ifc_class="IfcOpeningElement",
        name="Door opening",
    )
    model.createIfcRelVoidsElement(
        GlobalId=__import__("ifcopenshell").guid.new(),
        RelatingBuildingElement=wall,
        RelatedOpeningElement=opening,
    )
    before = model.to_string()
    with pytest.raises(WallAuthoringError, match="hosting an opening"):
        edit_straight_wall(model, guid, _straight())
    assert model.to_string() == before
    assert opening.VoidsElements[0].RelatingBuildingElement.GlobalId == guid


def test_rejects_unknown_identity_or_unsupported_storey():
    model, storey_guid = _fixture()
    with pytest.raises(WallAuthoringError, match="storey"):
        create_straight_wall(model, "not-an-id", _straight())
    with pytest.raises(WallAuthoringError, match="IfcWall"):
        edit_straight_wall(model, storey_guid, _straight())
