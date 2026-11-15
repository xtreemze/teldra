from __future__ import annotations

import ifcopenshell.api.root
import pytest
from teldra_ifc import create_ifc4_home, open_model, write_model
from teldra_ifc.wall_authoring import (
    StraightWall,
    WallAuthoringError,
    create_straight_wall,
    delete_straight_wall,
    edit_straight_wall,
    inspect_wall_edit_eligibility,
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
    with pytest.raises(WallAuthoringError, match="IfcBuildingStorey"):
        create_straight_wall(model, "not-an-id", _straight())
    with pytest.raises(WallAuthoringError, match="IfcWall"):
        edit_straight_wall(model, storey_guid, _straight())


def test_edit_eligibility_matches_writer_for_unhosted_and_hosted_walls():
    model, storey_guid = _fixture()
    model, guid = create_straight_wall(model, storey_guid, _straight())
    initial = model.to_string()
    assert inspect_wall_edit_eligibility(model, guid) == (True, None)
    assert model.to_string() == initial

    wall = model.by_guid(guid)
    opening = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcOpeningElement", name="Hosted opening"
    )
    model.createIfcRelVoidsElement(
        GlobalId=__import__("ifcopenshell").guid.new(),
        RelatingBuildingElement=wall,
        RelatedOpeningElement=opening,
    )
    hosted = model.to_string()
    eligible, reason = inspect_wall_edit_eligibility(model, guid)
    assert eligible is False
    assert "hosting an opening" in reason
    assert model.to_string() == hosted
    with pytest.raises(WallAuthoringError, match="hosting an opening"):
        edit_straight_wall(model, guid, _straight())
    assert model.to_string() == hosted


def test_edit_eligibility_rejects_missing_and_non_geometric_wall():
    model, storey_guid = _fixture()
    assert inspect_wall_edit_eligibility(model, "missing")[0] is False
    assert inspect_wall_edit_eligibility(model, storey_guid)[0] is False
    original_wall = next(w for w in model.by_type("IfcWall"))
    eligible, reason = inspect_wall_edit_eligibility(model, original_wall.GlobalId)
    assert eligible is False
    assert "Body representation" in reason


def test_delete_independent_straight_wall_preserves_original_and_other_guids():
    model, storey_guid = _fixture()
    model, wall_guid = create_straight_wall(model, storey_guid, _straight())
    original = model.to_string()
    original_other_guids = {
        element.GlobalId
        for element in model.by_type("IfcRoot")
        if element.GlobalId != wall_guid
    }
    removed = delete_straight_wall(model, wall_guid)
    assert model.to_string() == original
    assert not any(wall.GlobalId == wall_guid for wall in removed.by_type("IfcWall"))
    assert all(removed.by_guid(guid) is not None for guid in original_other_guids)


def test_delete_refuses_hosted_openings_and_keeps_original_relationships():
    model, storey_guid = _fixture()
    model, wall_guid = create_straight_wall(model, storey_guid, _straight())
    opening = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcOpeningElement", name="Window opening"
    )
    model.createIfcRelVoidsElement(
        GlobalId=__import__("ifcopenshell").guid.new(),
        RelatingBuildingElement=model.by_guid(wall_guid),
        RelatedOpeningElement=opening,
    )
    before = model.to_string()
    with pytest.raises(WallAuthoringError, match="hosting an opening"):
        delete_straight_wall(model, wall_guid)
    assert model.to_string() == before


def test_delete_refuses_unreviewed_wall_relationships():
    model, storey_guid = _fixture()
    model, wall_guid = create_straight_wall(model, storey_guid, _straight())
    wall = model.by_guid(wall_guid)
    group = ifcopenshell.api.root.create_entity(model, ifc_class="IfcGroup", name="Group")
    model.createIfcRelAssignsToGroup(
        GlobalId=__import__("ifcopenshell").guid.new(),
        RelatedObjects=[wall],
        RelatingGroup=group,
    )
    before = model.to_string()
    with pytest.raises(WallAuthoringError, match="IfcRelAssignsToGroup"):
        delete_straight_wall(model, wall_guid)
    assert model.to_string() == before
