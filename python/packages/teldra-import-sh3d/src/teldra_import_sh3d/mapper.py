from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from math import cos, sin
from types import MappingProxyType

import ifcopenshell
import ifcopenshell.api.aggregate
import ifcopenshell.api.geometry
import ifcopenshell.api.pset
import ifcopenshell.api.root
import ifcopenshell.api.spatial
import numpy as np
from teldra_ifc import create_ifc4_project
from teldra_sh3d import Sh3dCamera, Sh3dHome, Sh3dSourceRef


class Sh3dIfcMappingError(ValueError):
    """Raised when SH3D semantics cannot be mapped without guessing."""


@dataclass(frozen=True, slots=True)
class Sh3dIfcImportResult:
    model: ifcopenshell.file
    source_to_global_id: Mapping[str, str]
    cameras: tuple[Sh3dCamera, ...]
    warnings: tuple[str, ...]


def source_to_canonical(
    x_m: float,
    y_m: float,
    z_m: float = 0.0,
) -> tuple[float, float, float]:
    """Convert SH3D plan coordinates to Teldra's right-handed Z-up frame."""

    return (x_m, -y_m, z_m)


def source_yaw_to_canonical(angle_rad: float) -> float:
    """Convert SH3D clockwise-plan yaw into canonical right-handed Z-up yaw."""

    return -angle_rad


def import_home_to_ifc(
    home: Sh3dHome,
    *,
    project_name: str | None = None,
) -> Sh3dIfcImportResult:
    model, spine, contexts = create_ifc4_project(project_name or home.name or "Imported SH3D Home")
    source_to_global_id: dict[str, str] = {}
    warnings: list[str] = []
    levels: dict[str, ifcopenshell.entity_instance] = {}

    for level in home.levels:
        storey = ifcopenshell.api.root.create_entity(
            model,
            ifc_class="IfcBuildingStorey",
            name=level.name,
        )
        ifcopenshell.api.aggregate.assign_object(
            model,
            relating_object=spine.building,
            products=[storey],
        )
        ifcopenshell.api.geometry.edit_object_placement(
            model,
            product=storey,
            matrix=_placement_matrix(0.0, 0.0, level.elevation_m, 0.0),
            is_si=True,
        )
        _attach_provenance(model, storey, level.source)
        _remember(source_to_global_id, level.source, storey)

        if level.source.source_id is not None:
            levels[level.source.source_id] = storey

    for room in home.rooms:
        container = _resolve_level(levels, room.level_id, room.source.key)
        space = ifcopenshell.api.root.create_entity(
            model,
            ifc_class="IfcSpace",
            name=room.name or room.source.key,
        )
        ifcopenshell.api.aggregate.assign_object(
            model,
            relating_object=container,
            products=[space],
        )
        _attach_provenance(model, space, room.source)
        _remember(source_to_global_id, room.source, space)

    for wall in home.walls:
        container = _resolve_level(levels, wall.level_id, wall.source.key)
        wall_entity = ifcopenshell.api.root.create_entity(
            model,
            ifc_class="IfcWall",
            name=wall.source.key,
        )
        ifcopenshell.api.spatial.assign_container(
            model,
            relating_structure=container,
            products=[wall_entity],
        )
        _attach_provenance(model, wall_entity, wall.source)
        _remember(source_to_global_id, wall.source, wall_entity)

        if wall.arc_extent_rad not in (None, 0.0):
            warnings.append(f"{wall.source.key}: curved wall body geometry is deferred.")
            continue

        wall_height = wall.height_m or home.default_wall_height_m
        if wall_height is None:
            warnings.append(
                f"{wall.source.key}: wall height is unavailable; body geometry is deferred."
            )
            continue

        level_elevation = _global_z(container)
        start = source_to_canonical(wall.start.x_m, wall.start.y_m, level_elevation)
        end = source_to_canonical(wall.end.x_m, wall.end.y_m, level_elevation)
        representation = ifcopenshell.api.geometry.create_2pt_wall(
            model,
            element=wall_entity,
            context=contexts.body,
            p1=(start[0], start[1]),
            p2=(end[0], end[1]),
            elevation=level_elevation,
            height=wall_height,
            thickness=wall.thickness_m,
            is_si=True,
        )
        ifcopenshell.api.geometry.assign_representation(
            model,
            product=wall_entity,
            representation=representation,
        )

    for piece in home.furniture:
        container = _resolve_level(levels, piece.level_id, piece.source.key)
        entity = _create_furniture_entity(model, piece.kind, piece.name)
        ifcopenshell.api.spatial.assign_container(
            model,
            relating_structure=container,
            products=[entity],
        )
        level_elevation = _global_z(container)
        x, y, z = source_to_canonical(
            piece.x_m,
            piece.y_m,
            level_elevation + piece.elevation_m,
        )
        ifcopenshell.api.geometry.edit_object_placement(
            model,
            product=entity,
            matrix=_placement_matrix(
                x,
                y,
                z,
                source_yaw_to_canonical(piece.angle_rad),
            ),
            is_si=True,
        )
        _attach_provenance(
            model,
            entity,
            piece.source,
            extra={
                "SourceWidthMetres": piece.width_m,
                "SourceDepthMetres": piece.depth_m,
                "SourceHeightMetres": piece.height_m,
            },
        )
        _remember(source_to_global_id, piece.source, entity)

    for unsupported in home.unsupported_elements:
        warnings.append(f"Unsupported SH3D element class: {unsupported}.")

    return Sh3dIfcImportResult(
        model=model,
        source_to_global_id=MappingProxyType(source_to_global_id.copy()),
        cameras=home.cameras,
        warnings=tuple(warnings),
    )


def _create_furniture_entity(
    model: ifcopenshell.file,
    kind: str,
    name: str,
) -> ifcopenshell.entity_instance:
    if kind == "pieceOfFurniture":
        return ifcopenshell.api.root.create_entity(
            model,
            ifc_class="IfcFurniture",
            name=name,
        )
    if kind == "light":
        return ifcopenshell.api.root.create_entity(
            model,
            ifc_class="IfcLightFixture",
            name=name,
        )
    if kind == "doorOrWindow":
        entity = ifcopenshell.api.root.create_entity(
            model,
            ifc_class="IfcBuildingElementProxy",
            name=name,
        )
        entity.ObjectType = "Sweet Home 3D DoorOrWindow"
        return entity
    raise Sh3dIfcMappingError(f'Unsupported SH3D furniture kind "{kind}".')


def _resolve_level(
    levels: Mapping[str, ifcopenshell.entity_instance],
    level_id: str | None,
    source_key: str,
) -> ifcopenshell.entity_instance:
    if level_id is None:
        raise Sh3dIfcMappingError(
            f"{source_key} has no level reference; importing unlevelled elements is deferred."
        )
    try:
        return levels[level_id]
    except KeyError as error:
        raise Sh3dIfcMappingError(
            f'{source_key} references unknown SH3D level "{level_id}".'
        ) from error


def _attach_provenance(
    model: ifcopenshell.file,
    entity: ifcopenshell.entity_instance,
    source: Sh3dSourceRef,
    *,
    extra: Mapping[str, object] | None = None,
) -> None:
    properties: dict[str, object] = {
        "SourceSystem": "Sweet Home 3D",
        "SourceElement": source.element,
        "SourceKey": source.key,
        "SourceOrdinal": source.ordinal,
        "SourceCoordinateFrame": "SH3D_PLAN_CM",
        "ImportTransform": "X=x;Y=-y;Z=elevation",
    }
    if source.source_id is not None:
        properties["SourceId"] = source.source_id
    if extra:
        properties.update(extra)

    pset = ifcopenshell.api.pset.add_pset(
        model,
        product=entity,
        name="Teldra_Source",
    )
    ifcopenshell.api.pset.edit_pset(
        model,
        pset=pset,
        properties=properties,
    )


def _remember(
    mapping: dict[str, str],
    source: Sh3dSourceRef,
    entity: ifcopenshell.entity_instance,
) -> None:
    if source.key in mapping:
        raise Sh3dIfcMappingError(f'Duplicate SH3D source identity "{source.key}".')
    mapping[source.key] = entity.GlobalId


def _placement_matrix(
    x_m: float,
    y_m: float,
    z_m: float,
    yaw_rad: float,
) -> np.ndarray:
    c = cos(yaw_rad)
    s = sin(yaw_rad)
    return np.array(
        [
            [c, -s, 0.0, x_m],
            [s, c, 0.0, y_m],
            [0.0, 0.0, 1.0, z_m],
            [0.0, 0.0, 0.0, 1.0],
        ],
        dtype=float,
    )


def _global_z(entity: ifcopenshell.entity_instance) -> float:
    placement = entity.ObjectPlacement
    if placement is None:
        return 0.0

    import ifcopenshell.util.placement

    return float(ifcopenshell.util.placement.get_local_placement(placement)[2][3])
