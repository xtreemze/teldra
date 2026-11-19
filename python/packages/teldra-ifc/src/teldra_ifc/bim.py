"""Source-format-independent IFC4 BIM building blocks.

Walls with a reference Axis and a material layer set (what IfcOpenShell's
``regenerate_wall_representation`` and Bonsai edit), openings with real Body
solids placed in their host wall's frame, fillings placed in their opening's
frame, and spaces with a plan footprint plus a body.

Conventions (shared with the TypeScript writer in ``@teldra/ifc-edit``): the
wall placement's local X axis is the reference line from start to end; the Body
spans local X ``0..L`` and local Y ``0..t`` (``OffsetFromReferenceLine`` = 0,
``DirectionSense`` = POSITIVE); local Z is up from the wall base.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from math import cos, hypot, sin

import ifcopenshell
import ifcopenshell.api.aggregate
import ifcopenshell.api.feature
import ifcopenshell.api.geometry
import ifcopenshell.api.material
import ifcopenshell.api.root
import ifcopenshell.util.element
import ifcopenshell.util.placement
import numpy as np

from .model import IfcModelContexts


class BimAuthoringError(ValueError):
    """Raised when a BIM construct cannot be authored without guessing."""


# ---------------------------------------------------------------- placements


def create_local_placement(
    model: ifcopenshell.file,
    relative_to: ifcopenshell.entity_instance | None,
    matrix: np.ndarray,
) -> ifcopenshell.entity_instance:
    """Create an ``IfcLocalPlacement`` with an explicit placement-relative 4x4 matrix.

    Unlike ``geometry.edit_object_placement`` this never recomputes against the
    product's container, so the placement chain is exactly what the caller asked for.
    """

    point = model.createIfcCartesianPoint([float(v) for v in matrix[:3, 3]])
    axis = model.createIfcDirection([float(v) for v in matrix[:3, 2]])
    ref_direction = model.createIfcDirection([float(v) for v in matrix[:3, 0]])
    relative = model.createIfcAxis2Placement3D(point, axis, ref_direction)
    return model.createIfcLocalPlacement(relative_to, relative)


def world_matrix(entity: ifcopenshell.entity_instance) -> np.ndarray:
    return np.asarray(
        ifcopenshell.util.placement.get_local_placement(entity.ObjectPlacement), dtype=float
    )


def yaw_matrix(x: float, y: float, z: float, yaw_rad: float) -> np.ndarray:
    c, s = cos(yaw_rad), sin(yaw_rad)
    return np.array(
        [[c, -s, 0.0, x], [s, c, 0.0, y], [0.0, 0.0, 1.0, z], [0.0, 0.0, 0.0, 1.0]], dtype=float
    )


# ---------------------------------------------------------------- walls


@dataclass(slots=True)
class WallLayerLibrary:
    """Shares one ``IfcMaterial`` and one single-layer set per distinct thickness."""

    model: ifcopenshell.file
    material_name: str = "Wall"
    _material: ifcopenshell.entity_instance | None = None
    _sets: dict[int, ifcopenshell.entity_instance] = field(default_factory=dict)

    def layer_set(self, thickness_m: float) -> ifcopenshell.entity_instance:
        key = round(thickness_m * 1_000_000)
        existing = self._sets.get(key)
        if existing is not None:
            return existing
        if self._material is None:
            self._material = ifcopenshell.api.material.add_material(
                self.model, name=self.material_name
            )
        layer_set = ifcopenshell.api.material.add_material_set(
            self.model,
            name=f"{self.material_name} {thickness_m * 1000:g} mm",
            set_type="IfcMaterialLayerSet",
        )
        layer = ifcopenshell.api.material.add_layer(
            self.model, layer_set=layer_set, material=self._material
        )
        ifcopenshell.api.material.edit_layer(
            self.model, layer=layer, attributes={"LayerThickness": thickness_m}
        )
        self._sets[key] = layer_set
        return layer_set


def add_wall_axis_and_layers(
    model: ifcopenshell.file,
    contexts: IfcModelContexts,
    wall: ifcopenshell.entity_instance,
    *,
    length_m: float,
    thickness_m: float,
    library: WallLayerLibrary,
) -> None:
    """Give an already bodied wall its Axis representation and layer-set usage.

    The result is what ``geometry.regenerate_wall_representation`` consumes:
    regenerating an unconnected wall reproduces its Body.
    """

    if contexts.axis is None:
        raise BimAuthoringError("Model has no Plan/Axis context.")
    axis = ifcopenshell.api.geometry.add_axis_representation(
        model, context=contexts.axis, axis=[(0.0, 0.0), (length_m, 0.0)]
    )
    ifcopenshell.api.geometry.assign_representation(model, product=wall, representation=axis)
    ifcopenshell.api.material.assign_material(
        model,
        products=[wall],
        type="IfcMaterialLayerSetUsage",
        material=library.layer_set(thickness_m),
    )
    usage = ifcopenshell.util.element.get_material(wall)
    usage.OffsetFromReferenceLine = 0.0
    usage.DirectionSense = "POSITIVE"


def wall_body_interval(wall: ifcopenshell.entity_instance) -> tuple[float, float]:
    """Local-Y extent ``(min, max)`` of the wall body from its layer-set usage."""

    usage = ifcopenshell.util.element.get_material(wall)
    if usage is None or not usage.is_a("IfcMaterialLayerSetUsage"):
        raise BimAuthoringError(f"Wall {wall.GlobalId} has no material layer set usage.")
    thickness = sum(layer.LayerThickness for layer in usage.ForLayerSet.MaterialLayers)
    offset = float(usage.OffsetFromReferenceLine or 0.0)
    if usage.DirectionSense == "NEGATIVE":
        return offset - thickness, offset
    return offset, offset + thickness


def connect_wall_ends(
    model: ifcopenshell.file,
    relating: ifcopenshell.entity_instance,
    relating_end: str,
    related: ifcopenshell.entity_instance,
    related_end: str,
) -> ifcopenshell.entity_instance:
    """Create an ``IfcRelConnectsPathElements`` between two wall ends (ATSTART/ATEND)."""

    for end in (relating_end, related_end):
        if end not in {"ATSTART", "ATEND"}:
            raise BimAuthoringError(f"Unsupported wall end {end!r}.")
    return ifcopenshell.api.geometry.connect_path(
        model,
        relating_element=relating,
        related_element=related,
        relating_connection=relating_end,
        related_connection=related_end,
    )


# ---------------------------------------------------------------- openings


def _rectangle_solid(
    model: ifcopenshell.file,
    *,
    width: float,
    depth: float,
    height: float,
) -> ifcopenshell.entity_instance:
    """Axis-aligned box whose local origin is its minimum corner."""

    centre = model.createIfcCartesianPoint((width / 2.0, depth / 2.0))
    profile = model.createIfcRectangleProfileDef(
        "AREA", None, model.createIfcAxis2Placement2D(centre, None), width, depth
    )
    origin = model.createIfcCartesianPoint((0.0, 0.0, 0.0))
    position = model.createIfcAxis2Placement3D(origin, None, None)
    up = model.createIfcDirection((0.0, 0.0, 1.0))
    return model.createIfcExtrudedAreaSolid(profile, position, up, height)


def create_hosted_opening(
    model: ifcopenshell.file,
    contexts: IfcModelContexts,
    host: ifcopenshell.entity_instance,
    *,
    name: str,
    along_m: float,
    width_m: float,
    bottom_m: float,
    height_m: float,
    margin_m: float = 0.01,
) -> ifcopenshell.entity_instance:
    """Create an ``IfcOpeningElement`` with a Body that cuts ``host`` through its thickness.

    ``along_m`` is the cut's start along the wall reference line and ``bottom_m``
    its height above the wall base. The cut passes ``margin_m`` beyond both wall
    faces so the boolean never leaves coplanar slivers. The opening is placed
    relative to ``host``'s ObjectPlacement, so it travels with the wall.
    """

    if min(width_m, height_m) <= 0:
        raise BimAuthoringError("Opening dimensions must be positive.")
    y_min, y_max = wall_body_interval(host)
    depth = (y_max - y_min) + 2.0 * margin_m
    opening = ifcopenshell.api.root.create_entity(model, ifc_class="IfcOpeningElement", name=name)
    opening.PredefinedType = "OPENING"
    solid = _rectangle_solid(model, width=width_m, depth=depth, height=height_m)
    body = model.createIfcShapeRepresentation(contexts.body, "Body", "SweptSolid", [solid])
    opening.Representation = model.createIfcProductDefinitionShape(None, None, [body])
    local = np.eye(4)
    local[:3, 3] = (along_m, y_min - margin_m, bottom_m)
    opening.ObjectPlacement = create_local_placement(model, host.ObjectPlacement, local)
    ifcopenshell.api.feature.add_feature(model, feature=opening, element=host)
    return opening


def place_filling_in_opening(
    model: ifcopenshell.file,
    opening: ifcopenshell.entity_instance,
    filling: ifcopenshell.entity_instance,
    filling_world: np.ndarray,
) -> None:
    """Fill the opening and express the filling's pose in the opening's frame.

    The filling keeps its exact world pose; only the placement chain changes.
    """

    relative = np.linalg.inv(world_matrix(opening)) @ filling_world
    filling.ObjectPlacement = create_local_placement(model, opening.ObjectPlacement, relative)
    ifcopenshell.api.feature.add_filling(model, opening=opening, element=filling)


# ---------------------------------------------------------------- spaces


def _clean_polygon(points: Sequence[tuple[float, float]]) -> list[tuple[float, float]]:
    cleaned: list[tuple[float, float]] = []
    for point in points:
        if not cleaned or hypot(point[0] - cleaned[-1][0], point[1] - cleaned[-1][1]) > 1e-9:
            cleaned.append((float(point[0]), float(point[1])))
    if (
        len(cleaned) > 1
        and hypot(cleaned[0][0] - cleaned[-1][0], cleaned[0][1] - cleaned[-1][1]) <= 1e-9
    ):
        cleaned.pop()
    return cleaned


def signed_area(points: Sequence[tuple[float, float]]) -> float:
    total = 0.0
    for (x1, y1), (x2, y2) in zip(points, [*points[1:], points[0]], strict=True):
        total += x1 * y2 - x2 * y1
    return total / 2.0


def create_space_with_footprint(
    model: ifcopenshell.file,
    contexts: IfcModelContexts,
    storey: ifcopenshell.entity_instance,
    *,
    name: str,
    polygon: Sequence[tuple[float, float]],
    height_m: float,
) -> ifcopenshell.entity_instance | None:
    """Create an ``IfcSpace`` aggregated into ``storey`` with FootPrint and Body.

    ``polygon`` is in the storey's local XY frame. Returns ``None`` when the
    polygon is degenerate (fewer than three distinct points or no area); the
    caller decides how to report it.
    """

    points = _clean_polygon(polygon)
    if len(points) < 3 or abs(signed_area(points)) < 1e-6 or height_m <= 0:
        return None
    if signed_area(points) < 0:
        points.reverse()  # canonical profiles are counter-clockwise
    if contexts.footprint is None:
        raise BimAuthoringError("Model has no Plan/FootPrint context.")

    space = ifcopenshell.api.root.create_entity(model, ifc_class="IfcSpace", name=name)
    space.PredefinedType = "INTERNAL"
    ifcopenshell.api.aggregate.assign_object(model, relating_object=storey, products=[space])
    space.ObjectPlacement = create_local_placement(model, storey.ObjectPlacement, np.eye(4))

    closed = [*points, points[0]]
    outline = model.createIfcPolyline([model.createIfcCartesianPoint(p) for p in closed])
    profile = model.createIfcArbitraryClosedProfileDef("AREA", None, outline)
    origin = model.createIfcCartesianPoint((0.0, 0.0, 0.0))
    position = model.createIfcAxis2Placement3D(origin, None, None)
    up = model.createIfcDirection((0.0, 0.0, 1.0))
    solid = model.createIfcExtrudedAreaSolid(profile, position, up, height_m)
    body = model.createIfcShapeRepresentation(contexts.body, "Body", "SweptSolid", [solid])
    footprint_curve = model.createIfcPolyline([model.createIfcCartesianPoint(p) for p in closed])
    footprint = model.createIfcShapeRepresentation(
        contexts.footprint, "FootPrint", "Curve2D", [footprint_curve]
    )
    space.Representation = model.createIfcProductDefinitionShape(None, None, [footprint, body])
    return space
