from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import ifcopenshell
import ifcopenshell.api.aggregate
import ifcopenshell.api.project
import ifcopenshell.api.root
import ifcopenshell.api.spatial
import ifcopenshell.api.unit


@dataclass(frozen=True, slots=True)
class HomeModelIds:
    project: str
    site: str
    building: str
    storey: str
    space: str
    wall: str


def create_ifc4_home(name: str = "Teldra Home") -> tuple[ifcopenshell.file, HomeModelIds]:
    """Create the minimal canonical IFC4 spatial spine used by Teldra tests."""

    model = ifcopenshell.api.project.create_file(version="IFC4")
    project = ifcopenshell.api.root.create_entity(
        model,
        ifc_class="IfcProject",
        name=name,
    )
    _assign_si_units(model)

    site = ifcopenshell.api.root.create_entity(
        model,
        ifc_class="IfcSite",
        name=f"{name} Site",
    )
    building = ifcopenshell.api.root.create_entity(
        model,
        ifc_class="IfcBuilding",
        name=name,
    )
    storey = ifcopenshell.api.root.create_entity(
        model,
        ifc_class="IfcBuildingStorey",
        name="Ground Floor",
    )
    space = ifcopenshell.api.root.create_entity(
        model,
        ifc_class="IfcSpace",
        name="Living room",
    )
    wall = ifcopenshell.api.root.create_entity(
        model,
        ifc_class="IfcWall",
        name="Living room wall",
    )

    ifcopenshell.api.aggregate.assign_object(
        model,
        relating_object=project,
        products=[site],
    )
    ifcopenshell.api.aggregate.assign_object(
        model,
        relating_object=site,
        products=[building],
    )
    ifcopenshell.api.aggregate.assign_object(
        model,
        relating_object=building,
        products=[storey],
    )
    ifcopenshell.api.aggregate.assign_object(
        model,
        relating_object=storey,
        products=[space],
    )
    ifcopenshell.api.spatial.assign_container(
        model,
        relating_structure=storey,
        products=[wall],
    )

    return model, HomeModelIds(
        project=project.GlobalId,
        site=site.GlobalId,
        building=building.GlobalId,
        storey=storey.GlobalId,
        space=space.GlobalId,
        wall=wall.GlobalId,
    )


def write_model(model: ifcopenshell.file, destination: str | Path) -> Path:
    path = Path(destination)
    path.parent.mkdir(parents=True, exist_ok=True)
    model.write(str(path))
    return path


def open_model(source: str | Path) -> ifcopenshell.file:
    return ifcopenshell.open(str(Path(source)))


def _assign_si_units(model: ifcopenshell.file) -> None:
    units = [
        ifcopenshell.api.unit.add_si_unit(model, unit_type="LENGTHUNIT"),
        ifcopenshell.api.unit.add_si_unit(model, unit_type="AREAUNIT"),
        ifcopenshell.api.unit.add_si_unit(model, unit_type="VOLUMEUNIT"),
        ifcopenshell.api.unit.add_si_unit(model, unit_type="PLANEANGLEUNIT"),
    ]
    ifcopenshell.api.unit.assign_unit(model, units=units)
