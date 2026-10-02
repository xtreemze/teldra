from __future__ import annotations

import ifcopenshell

from teldra_ifc import create_ifc4_home, open_model, resolve_global_id, write_model


def test_create_ifc4_home_uses_explicit_si_metres_and_spatial_hierarchy() -> None:
    model, ids = create_ifc4_home()

    assert model.schema == "IFC4"
    assert len(model.by_type("IfcProject")) == 1

    project = resolve_global_id(model, ids.project, expected_class="IfcProject")
    site = resolve_global_id(model, ids.site, expected_class="IfcSite")
    building = resolve_global_id(model, ids.building, expected_class="IfcBuilding")
    storey = resolve_global_id(model, ids.storey, expected_class="IfcBuildingStorey")
    space = resolve_global_id(model, ids.space, expected_class="IfcSpace")
    wall = resolve_global_id(model, ids.wall, expected_class="IfcWall")

    assert _is_aggregated(model, project, site)
    assert _is_aggregated(model, site, building)
    assert _is_aggregated(model, building, storey)
    assert _is_aggregated(model, storey, space)
    assert _is_contained(model, storey, wall)

    units = {unit.UnitType: unit for unit in project.UnitsInContext.Units}
    assert units["LENGTHUNIT"].Name == "METRE"
    assert units["LENGTHUNIT"].Prefix is None
    assert units["PLANEANGLEUNIT"].Name == "RADIAN"


def test_global_ids_survive_write_reload_and_non_destructive_edit(tmp_path) -> None:
    model, ids = create_ifc4_home()
    wall = resolve_global_id(model, ids.wall, expected_class="IfcWall")
    wall.Name = "Renamed living room wall"

    path = write_model(model, tmp_path / "home.ifc")
    reloaded = open_model(path)

    for expected_class, global_id in (
        ("IfcProject", ids.project),
        ("IfcSite", ids.site),
        ("IfcBuilding", ids.building),
        ("IfcBuildingStorey", ids.storey),
        ("IfcSpace", ids.space),
        ("IfcWall", ids.wall),
    ):
        entity = resolve_global_id(
            reloaded,
            global_id,
            expected_class=expected_class,
        )
        assert entity.GlobalId == global_id

    assert resolve_global_id(reloaded, ids.wall).Name == "Renamed living room wall"


def _is_aggregated(
    model: ifcopenshell.file,
    parent: ifcopenshell.entity_instance,
    child: ifcopenshell.entity_instance,
) -> bool:
    return any(
        relationship.RelatingObject == parent and child in relationship.RelatedObjects
        for relationship in model.by_type("IfcRelAggregates")
    )


def _is_contained(
    model: ifcopenshell.file,
    container: ifcopenshell.entity_instance,
    product: ifcopenshell.entity_instance,
) -> bool:
    return any(
        relationship.RelatingStructure == container and product in relationship.RelatedElements
        for relationship in model.by_type("IfcRelContainedInSpatialStructure")
    )
