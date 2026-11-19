from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from math import atan2, cos, hypot, sin
from types import MappingProxyType

import ifcopenshell
import ifcopenshell.api.aggregate
import ifcopenshell.api.geometry
import ifcopenshell.api.pset
import ifcopenshell.api.root
import ifcopenshell.api.spatial
import ifcopenshell.guid
import numpy as np
from teldra_ifc import (
    WallLayerLibrary,
    add_wall_axis_and_layers,
    connect_wall_ends,
    create_hosted_opening,
    create_ifc4_project,
    create_local_placement,
    create_space_with_footprint,
    place_filling_in_opening,
)
from teldra_sh3d import (
    Sh3dCamera,
    Sh3dFurniture,
    Sh3dHome,
    Sh3dSourceRef,
    Sh3dWall,
)

HOSTED_OPENING_ROLE = "HostedOpening"
_PSET_NAMESPACE = uuid.UUID("6d1b2a3e-5c0f-4f7e-9a41-7a0d3f5e2b10")
_WALL_LINK_TOLERANCE_M = 0.01
_FLOOR_LEVEL_DOOR_ELEVATION_M = 0.05
_WINDOW_WORDS = ("window", "fenetre", "fenêtre", "ventana", "fenster", "finestra", "vitre")
_DOOR_WORDS = ("door", "porte", "puerta", "tür", "tuer", "porta")


class Sh3dIfcMappingError(ValueError):
    """Raised when SH3D semantics cannot be mapped without guessing."""


@dataclass(frozen=True, slots=True)
class Sh3dIfcImportResult:
    model: ifcopenshell.file
    source_to_global_id: Mapping[str, str]
    cameras: tuple[Sh3dCamera, ...]
    warnings: tuple[str, ...]
    # SH3D elements/attributes the parser and importer do not model, as
    # {"path": tag or tag@attribute, "kind": "element"|"attribute", "count": n}.
    # Everything unmodelled is listed; nothing is silently dropped.
    loss_report: tuple[Mapping[str, object], ...] = ()
    # What the import produced (bodies, hosted fillings, spaces, path
    # connections) plus explicit lists of what could not be hosted or connected.
    bim_summary: Mapping[str, object] = field(default_factory=dict)


@dataclass(slots=True)
class _MappedWall:
    source: Sh3dWall
    entity: ifcopenshell.entity_instance
    # Set only for straight walls that received a Body, Axis and layer set.
    length_m: float | None = None
    height_m: float | None = None


@dataclass(slots=True)
class _Summary:
    spaces: int = 0
    spaces_with_body: int = 0
    doors_and_windows: int = 0
    hosted: int = 0
    unhosted: list[dict[str, str]] = field(default_factory=list)
    unresolved_links: list[dict[str, str]] = field(default_factory=list)

    def as_mapping(self, model: ifcopenshell.file) -> dict[str, object]:
        walls = model.by_type("IfcWall")
        return {
            "spaces": self.spaces,
            "spacesWithBody": self.spaces_with_body,
            "wallsWithAxisAndLayers": sum(
                1
                for wall in walls
                if wall.Representation is not None
                and any(
                    rep.RepresentationIdentifier == "Axis"
                    for rep in wall.Representation.Representations
                )
            ),
            "doorsAndWindows": self.doors_and_windows,
            "hostedDoorsAndWindows": self.hosted,
            "unhostedDoorsAndWindows": list(self.unhosted),
            "openingsWithBody": sum(
                1 for o in model.by_type("IfcOpeningElement") if o.Representation is not None
            ),
            "pathConnections": len(model.by_type("IfcRelConnectsPathElements")),
            "unresolvedWallLinks": len(self.unresolved_links),
            "unresolvedWallLinkDetails": list(self.unresolved_links),
        }


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
    existing_model: ifcopenshell.file | None = None,
) -> Sh3dIfcImportResult:
    preserved_global_ids, preserved_derived_ids = (
        _source_global_ids(existing_model) if existing_model is not None else ({}, {})
    )
    model, spine, contexts = create_ifc4_project(project_name or home.name or "Imported SH3D Home")
    if existing_model is not None:
        _restore_spine_global_ids(existing_model, spine)
    source_to_global_id: dict[str, str] = {}
    warnings: list[str] = []
    levels: dict[str, ifcopenshell.entity_instance] = {}
    level_heights: dict[str, float] = {}
    mapped_walls: list[_MappedWall] = []
    layers = WallLayerLibrary(model)
    summary = _Summary()

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
        _restore_global_id(storey, level.source, preserved_global_ids)
        _attach_provenance(model, storey, level.source)
        _remember(source_to_global_id, level.source, storey)

        if level.source.source_id is not None:
            levels[level.source.source_id] = storey
            level_heights[level.source.source_id] = level.height_m

    for room in home.rooms:
        container = _resolve_level(levels, room.level_id, room.source.key)
        room_name = room.name or room.source.key
        space = create_space_with_footprint(
            model,
            contexts,
            container,
            name=room_name,
            polygon=[source_to_canonical(p.x_m, p.y_m)[:2] for p in room.points],
            height_m=level_heights.get(room.level_id or "", 0.0)
            or home.default_wall_height_m
            or 0.0,
        )
        summary.spaces += 1
        if space is None:
            # Keep the room's identity as a semantic-only space; never drop it.
            warnings.append(
                f"{room.source.key}: room outline is degenerate or its height is unavailable; "
                "IfcSpace was created without footprint or body."
            )
            space = ifcopenshell.api.root.create_entity(
                model,
                ifc_class="IfcSpace",
                name=room_name,
            )
            ifcopenshell.api.aggregate.assign_object(
                model,
                relating_object=container,
                products=[space],
            )
            space.ObjectPlacement = create_local_placement(
                model, container.ObjectPlacement, np.eye(4)
            )
        else:
            summary.spaces_with_body += 1
        _restore_global_id(space, room.source, preserved_global_ids)
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
        _restore_global_id(wall_entity, wall.source, preserved_global_ids)
        _attach_provenance(model, wall_entity, wall.source)
        _remember(source_to_global_id, wall.source, wall_entity)
        mapped = _MappedWall(source=wall, entity=wall_entity)
        mapped_walls.append(mapped)

        if wall.arc_extent_rad not in (None, 0.0):
            warnings.append(f"{wall.source.key}: curved wall body geometry is deferred.")
            continue

        wall_height = wall.height_m or home.default_wall_height_m
        if wall_height is None:
            warnings.append(
                f"{wall.source.key}: wall height is unavailable; body geometry is deferred."
            )
            continue
        if wall.height_at_end_m not in (None, wall_height):
            warnings.append(
                f"{wall.source.key}: sloped wall (heightAtEnd) imported at its start height."
            )

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
        length = hypot(end[0] - start[0], end[1] - start[1])
        add_wall_axis_and_layers(
            model,
            contexts,
            wall_entity,
            length_m=length,
            thickness_m=wall.thickness_m,
            library=layers,
        )
        mapped.length_m = length
        mapped.height_m = wall_height

    for piece in home.furniture:
        container = _resolve_level(levels, piece.level_id, piece.source.key)
        entity = _create_furniture_entity(model, piece)
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
        world = _placement_matrix(x, y, z, source_yaw_to_canonical(piece.angle_rad))
        extra: dict[str, object] = {
            "SourceWidthMetres": piece.width_m,
            "SourceDepthMetres": piece.depth_m,
            "SourceHeightMetres": piece.height_m,
        }

        hosted = False
        if piece.kind == "doorOrWindow":
            entity.OverallWidth = piece.width_m
            entity.OverallHeight = piece.height_m
            extra["ClassificationBasis"] = _classify_door_or_window(piece)[1]
            hosted = _host_door_or_window(
                model,
                contexts,
                piece,
                entity,
                world,
                mapped_walls,
                warnings,
                summary,
                preserved_derived_ids,
            )
        if not hosted:
            ifcopenshell.api.geometry.edit_object_placement(
                model,
                product=entity,
                matrix=world,
                is_si=True,
            )
        _restore_global_id(entity, piece.source, preserved_global_ids)
        _attach_provenance(model, entity, piece.source, extra=extra)
        _remember(source_to_global_id, piece.source, entity)

    _connect_walls(model, mapped_walls, warnings, summary)

    return Sh3dIfcImportResult(
        model=model,
        source_to_global_id=MappingProxyType(source_to_global_id.copy()),
        cameras=home.cameras,
        warnings=tuple(warnings),
        loss_report=tuple(
            {"path": entry.path, "kind": entry.kind, "count": entry.count}
            for entry in home.loss_entries
        ),
        bim_summary=MappingProxyType(summary.as_mapping(model)),
    )


def _connect_walls(
    model: ifcopenshell.file,
    mapped_walls: list[_MappedWall],
    warnings: list[str],
    summary: _Summary,
) -> None:
    """Create IfcRelConnectsPathElements for resolvable wallAtStart/wallAtEnd links.

    A link is resolvable when the neighbour exists on the same level, has a
    straight body, and one of its ends coincides with the linking end.
    Reciprocal links collapse into one relationship. Unresolvable links are
    reported, never guessed.
    """

    by_id = {
        mapped.source.source.source_id: index
        for index, mapped in enumerate(mapped_walls)
        if mapped.source.source.source_id is not None
    }
    used_ends: set[tuple[int, str]] = set()
    created: set[frozenset[tuple[int, str]]] = set()

    def end_point(mapped: _MappedWall, end: str) -> tuple[float, float]:
        point = mapped.source.start if end == "start" else mapped.source.end
        return source_to_canonical(point.x_m, point.y_m)[:2]

    for index, mapped in enumerate(mapped_walls):
        key = mapped.source.source.key
        for side, neighbour_id in (
            ("start", mapped.source.wall_at_start_id),
            ("end", mapped.source.wall_at_end_id),
        ):
            if neighbour_id is None:
                continue

            reason = _link_problem(mapped, neighbour_id, by_id, mapped_walls, index, side)
            other_side = ""
            other_index = by_id.get(neighbour_id, -1)
            if reason is None:
                other = mapped_walls[other_index]
                here = end_point(mapped, side)
                distance, other_side = min(
                    (hypot(here[0] - p[0], here[1] - p[1]), end)
                    for end in ("start", "end")
                    for p in (end_point(other, end),)
                )
                if distance > _WALL_LINK_TOLERANCE_M:
                    reason = f"{other.source.source.key} does not meet it at a coincident endpoint"
            if reason is None:
                pair = frozenset({(index, side), (other_index, other_side)})
                if pair in created:
                    continue
                if used_ends & pair:
                    reason = "the wall end is already connected to another wall"
            if reason is not None:
                summary.unresolved_links.append({"sourceKey": key, "end": side, "reason": reason})
                warnings.append(
                    f"{key}: wallAt{side.title()} link was not connected as a path "
                    f"connection: {reason}."
                )
                continue

            first, second = sorted([(index, side), (other_index, other_side)])
            connect_wall_ends(
                model,
                mapped_walls[first[0]].entity,
                f"AT{first[1].upper()}",
                mapped_walls[second[0]].entity,
                f"AT{second[1].upper()}",
            )
            created.add(pair)
            used_ends.update(pair)


def _link_problem(
    mapped: _MappedWall,
    neighbour_id: str,
    by_id: Mapping[str, int],
    mapped_walls: list[_MappedWall],
    index: int,
    side: str,
) -> str | None:
    if mapped.length_m is None:
        return "this wall has no straight body to connect"
    other_index = by_id.get(neighbour_id)
    if other_index is None:
        return f'it references missing wall "{neighbour_id}"'
    if other_index == index:
        return "it references itself"
    other = mapped_walls[other_index]
    if other.source.level_id != mapped.source.level_id:
        return f'"{neighbour_id}" is on another level'
    if other.length_m is None:
        return f'"{neighbour_id}" has no straight body to connect'
    return None


def _classify_door_or_window(piece: Sh3dFurniture) -> tuple[str, str]:
    """Return ``(IFC class, basis)``; SH3D has a single doorOrWindow element."""

    name = piece.name.casefold()
    is_window = any(word in name for word in _WINDOW_WORDS)
    is_door = any(word in name for word in _DOOR_WORDS)
    if is_window != is_door:
        return ("IfcWindow" if is_window else "IfcDoor"), "name"
    if piece.elevation_m < _FLOOR_LEVEL_DOOR_ELEVATION_M:
        return "IfcDoor", "elevation"
    return "IfcWindow", "elevation"


def _host_door_or_window(
    model: ifcopenshell.file,
    contexts,
    piece: Sh3dFurniture,
    filling: ifcopenshell.entity_instance,
    world: np.ndarray,
    mapped_walls: list[_MappedWall],
    warnings: list[str],
    summary: _Summary,
    preserved_derived_ids: Mapping[tuple[str, str], str],
) -> bool:
    """Create void, opening body and fill for a hostable door/window.

    Returns True when ``filling`` was placed in its opening's frame. Every
    failure is reported; the door/window itself is always kept.
    """

    key = piece.source.key
    summary.doors_and_windows += 1

    def unhosted(reason: str) -> bool:
        warnings.append(f"{key}: {reason}")
        summary.unhosted.append({"sourceKey": key, "reason": reason})
        return False

    binding = piece.wall_binding
    if binding is None or not binding.bound_to_wall:
        return unhosted(
            f"not bound to a wall (boundToWall=false); kept as an unhosted {filling.is_a()}."
        )

    candidates = [mapped for mapped in mapped_walls if _piece_matches_wall(piece, mapped.source)]
    if len(candidates) != 1:
        return unhosted(
            f"wall binding matched {len(candidates)} candidate host walls; "
            "opening relation was not created."
        )
    host = candidates[0]
    if host.length_m is None or host.height_m is None:
        return unhosted(
            f"host wall {host.source.source.key} has no straight body; "
            "opening relation was not created."
        )

    wall = host.source
    length = host.length_m
    dx = wall.end.x_m - wall.start.x_m
    dy = wall.end.y_m - wall.start.y_m
    along = ((piece.x_m - wall.start.x_m) * dx + (piece.y_m - wall.start.y_m) * dy) / length
    start = max(0.0, along - piece.width_m / 2.0)
    end = min(length, along + piece.width_m / 2.0)
    bottom = piece.elevation_m
    top = min(bottom + piece.height_m, host.height_m)
    if end - start <= 1e-6 or top - bottom <= 1e-6:
        return unhosted(
            f"opening lies outside host wall {host.source.source.key}; "
            "opening relation was not created."
        )
    if (
        start > along - piece.width_m / 2.0 + 1e-9
        or end < along + piece.width_m / 2.0 - 1e-9
        or top < bottom + piece.height_m - 1e-9
    ):
        warnings.append(
            f"{key}: opening extends beyond host wall {host.source.source.key} and was clipped."
        )
    if (
        binding.width_ratio != 1.0
        or binding.height_ratio != 1.0
        or binding.left_ratio != 0.0
        or binding.top_ratio != 0.0
    ):
        warnings.append(
            f"{key}: partial wall cut-out ratios are not applied; the full door/window box is cut."
        )

    opening = create_hosted_opening(
        model,
        contexts,
        host.entity,
        name=f"{piece.name} opening",
        along_m=start,
        width_m=end - start,
        bottom_m=bottom,
        height_m=top - bottom,
    )
    derived_id = preserved_derived_ids.get((key, HOSTED_OPENING_ROLE))
    if derived_id is not None:
        opening.GlobalId = derived_id
    _attach_provenance(
        model,
        opening,
        piece.source,
        extra={"DerivedRole": HOSTED_OPENING_ROLE},
    )
    place_filling_in_opening(model, opening, filling, world)
    summary.hosted += 1
    return True


def _piece_matches_wall(piece: Sh3dFurniture, wall: Sh3dWall) -> bool:
    if piece.level_id != wall.level_id:
        return False
    if wall.arc_extent_rad not in (None, 0.0):
        return False

    dx = wall.end.x_m - wall.start.x_m
    dy = wall.end.y_m - wall.start.y_m
    length = hypot(dx, dy)
    if length <= 1e-9:
        return False

    wall_angle = atan2(dy, dx)
    if abs(sin(piece.angle_rad - wall_angle)) > 1e-4:
        return False

    relative_x = piece.x_m - wall.start.x_m
    relative_y = piece.y_m - wall.start.y_m
    along = (relative_x * dx + relative_y * dy) / length
    half_width = piece.width_m / 2.0
    if along < -half_width or along > length + half_width:
        return False

    normal_distance = abs(relative_x * dy - relative_y * dx) / length
    host_tolerance = max(
        0.01,
        (wall.thickness_m + piece.depth_m) / 2.0,
    )
    return normal_distance <= host_tolerance


def _create_furniture_entity(
    model: ifcopenshell.file,
    piece: Sh3dFurniture,
) -> ifcopenshell.entity_instance:
    kind = piece.kind
    if kind in {"pieceOfFurniture", "shelfUnit"}:
        return ifcopenshell.api.root.create_entity(
            model,
            ifc_class="IfcFurniture",
            name=piece.name,
        )
    if kind == "light":
        return ifcopenshell.api.root.create_entity(
            model,
            ifc_class="IfcLightFixture",
            name=piece.name,
        )
    if kind == "doorOrWindow":
        entity = ifcopenshell.api.root.create_entity(
            model,
            ifc_class=_classify_door_or_window(piece)[0],
            name=piece.name,
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
    # Derive the pset id from its owner so re-imports do not churn GlobalIds.
    pset.GlobalId = ifcopenshell.guid.compress(
        uuid.uuid5(_PSET_NAMESPACE, f"{entity.GlobalId}:Teldra_Source").hex
    )
    ifcopenshell.api.pset.edit_pset(
        model,
        pset=pset,
        properties=properties,
    )


def _source_global_ids(
    model: ifcopenshell.file,
) -> tuple[dict[str, str], dict[tuple[str, str], str]]:
    """Recover IFC identities from a prior SH3D import.

    Returns ``(source key -> GlobalId, (source key, derived role) -> GlobalId)``.
    Derived objects (hosted openings) carry their source element's provenance
    but do not own its identity; they are tracked separately so they stay
    stable across re-imports without shadowing the filling.
    """

    import ifcopenshell.util.element

    identities: dict[str, str] = {}
    derived: dict[tuple[str, str], str] = {}
    for entity in model.by_type("IfcObject"):
        global_id = getattr(entity, "GlobalId", None)
        if not isinstance(global_id, str):
            continue

        pset = ifcopenshell.util.element.get_psets(entity).get("Teldra_Source")
        if not isinstance(pset, dict):
            continue
        if pset.get("SourceSystem") != "Sweet Home 3D":
            continue

        source_key = pset.get("SourceKey")
        if not isinstance(source_key, str):
            continue

        role = pset.get("DerivedRole")
        if role is not None:
            derived_key = (source_key, str(role))
            previous_derived = derived.get(derived_key)
            if previous_derived is not None and previous_derived != global_id:
                raise Sh3dIfcMappingError(
                    f"Existing IFC contains duplicate derived SH3D identity "
                    f'"{source_key}" ({role}).'
                )
            derived[derived_key] = global_id
            continue

        previous = identities.get(source_key)
        if previous is not None and previous != global_id:
            raise Sh3dIfcMappingError(
                f'Existing IFC contains duplicate SH3D source identity "{source_key}".'
            )
        identities[source_key] = global_id

    return identities, derived


def _restore_spine_global_ids(existing: ifcopenshell.file, spine) -> None:
    """Keep the project/site/building identities of a previously imported model.

    The importer always creates one of each, so only an unambiguous single
    match is adopted; anything else keeps the fresh identity.
    """

    for ifc_class, entity in (
        ("IfcProject", spine.project),
        ("IfcSite", spine.site),
        ("IfcBuilding", spine.building),
    ):
        previous = existing.by_type(ifc_class, include_subtypes=False)
        if len(previous) == 1:
            entity.GlobalId = previous[0].GlobalId


def _restore_global_id(
    entity: ifcopenshell.entity_instance,
    source: Sh3dSourceRef,
    preserved_global_ids: Mapping[str, str],
) -> None:
    global_id = preserved_global_ids.get(source.key)
    if global_id is not None:
        entity.GlobalId = global_id


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

    return float(world_matrix_of(placement)[2][3])


def world_matrix_of(placement: ifcopenshell.entity_instance) -> np.ndarray:
    import ifcopenshell.util.placement

    return np.asarray(ifcopenshell.util.placement.get_local_placement(placement), dtype=float)
