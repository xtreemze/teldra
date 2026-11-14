"""Restricted IFC4 straight-wall authoring on isolated canonical model copies.

These operations modify real IFC4 wall entities and Body representations.
They do NOT regenerate the corresponding derived GLB, update twin references,
or constitute a browser Studio command. A caller must complete those parts
within an atomic project transaction before exposing an Apply action.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import hypot, isfinite

import ifcopenshell
import ifcopenshell.api.geometry
import ifcopenshell.api.root
import ifcopenshell.api.spatial
import ifcopenshell.util.unit


class WallAuthoringError(ValueError):
    """Wall operation is unsupported or would damage IFC relationships."""


@dataclass(frozen=True, slots=True)
class StraightWall:
    start: tuple[float, float]
    end: tuple[float, float]
    thickness_m: float
    height_m: float
    elevation_m: float = 0.0


def _validate_wall(wall: StraightWall) -> None:
    if len(wall.start) != 2 or len(wall.end) != 2:
        raise WallAuthoringError("Wall endpoints must be 2D metre coordinates.")
    coordinates = (*wall.start, *wall.end, wall.thickness_m, wall.height_m, wall.elevation_m)
    if not all(isfinite(v) for v in coordinates):
        raise WallAuthoringError("Wall coordinates and dimensions must be finite.")
    length = hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])
    if not 1e-6 <= length <= 10_000:
        raise WallAuthoringError("Wall length is outside supported bounds.")
    if not 0 < wall.thickness_m <= 100 or not 0 < wall.height_m <= 100:
        raise WallAuthoringError("Wall thickness and height must be positive and bounded.")


def _isolated_model(source: ifcopenshell.file) -> ifcopenshell.file:
    if source.schema != "IFC4":
        raise WallAuthoringError("Only IFC4 is supported for wall authoring.")
    if abs(ifcopenshell.util.unit.calculate_unit_scale(source) - 1.0) > 1e-12:
        raise WallAuthoringError("Only metre-based IFC models are currently writable.")
    # Staging on a fresh IFC graph ensures errors never mutate the caller's
    # original model or the source project's IFC identity.
    return ifcopenshell.file.from_string(source.to_string())


def _body_context(model: ifcopenshell.file) -> ifcopenshell.entity_instance:
    contexts = [
        c
        for c in model.by_type("IfcGeometricRepresentationSubContext")
        if c.ContextIdentifier == "Body" and c.ContextType == "Model"
    ]
    if len(contexts) != 1:
        raise WallAuthoringError("A unique IFC Model/Body context is required.")
    return contexts[0]


def _find_global_id(model: ifcopenshell.file, guid: str) -> ifcopenshell.entity_instance | None:
    if not guid:
        return None
    try:
        return model.by_guid(guid)
    except RuntimeError:
        return None


def _storey(model: ifcopenshell.file, guid: str) -> ifcopenshell.entity_instance:
    element = _find_global_id(model, guid)
    if element is None or not element.is_a("IfcBuildingStorey"):
        raise WallAuthoringError("A valid target IfcBuildingStorey GlobalId is required.")
    return element


def _wall_by_guid(model: ifcopenshell.file, guid: str) -> ifcopenshell.entity_instance:
    element = _find_global_id(model, guid)
    if element is None or not element.is_a("IfcWall"):
        raise WallAuthoringError("A valid IfcWall GlobalId is required.")
    return element


def _create_body(
    model: ifcopenshell.file,
    wall: ifcopenshell.entity_instance,
    geometry: StraightWall,
) -> ifcopenshell.entity_instance:
    rep = ifcopenshell.api.geometry.create_2pt_wall(
        model,
        element=wall,
        context=_body_context(model),
        p1=geometry.start,
        p2=geometry.end,
        elevation=geometry.elevation_m,
        height=geometry.height_m,
        thickness=geometry.thickness_m,
        is_si=True,
    )
    ifcopenshell.api.geometry.assign_representation(
        model,
        product=wall,
        representation=rep,
    )
    return rep


def create_straight_wall(
    source: ifcopenshell.file,
    storey_global_id: str,
    geometry: StraightWall,
    *,
    name: str = "Wall",
) -> tuple[ifcopenshell.file, str]:
    """Create a real IfcWall, its spatial containment and extruded Body geometry.

    Returns an isolated candidate model plus its newly generated GlobalId.
    """
    _validate_wall(geometry)
    if not name.strip() or len(name) > 256:
        raise WallAuthoringError("Wall name must contain 1–256 nonblank characters.")
    model = _isolated_model(source)
    storey = _storey(model, storey_global_id)
    wall = ifcopenshell.api.root.create_entity(
        model,
        ifc_class="IfcWall",
        name=name,
    )
    wall.ObjectType = "TeldraAuthoringStraightWall"
    ifcopenshell.api.spatial.assign_container(
        model,
        relating_structure=storey,
        products=[wall],
    )
    _create_body(model, wall, geometry)
    return model, wall.GlobalId


def edit_straight_wall(
    source: ifcopenshell.file,
    wall_global_id: str,
    geometry: StraightWall,
) -> ifcopenshell.file:
    """Replace the unique Body of an eligible unhosted wall; preserve GlobalId.

    An opening or non-extruded/complex representation fails closed. Connected
    junction and space boundary recomputation is not implemented here, so walls
    with explicit IFC boundary/connectivity relations are not editable.
    """
    _validate_wall(geometry)
    model = _isolated_model(source)
    wall = _wall_by_guid(model, wall_global_id)
    for inverse in model.get_inverse(wall):
        if inverse.is_a("IfcRelVoidsElement"):
            raise WallAuthoringError("A wall hosting an opening requires dependent opening updates.")
        if (
            inverse.is_a("IfcRelConnectsElements")
            or inverse.is_a("IfcRelSpaceBoundary")
        ):
            raise WallAuthoringError("Connected or space-boundary walls require topology updates.")
    reps = list(wall.Representation.Representations) if wall.Representation else []
    if len(reps) != 1 or reps[0].RepresentationIdentifier != "Body":
        raise WallAuthoringError("Only a uniquely owned wall Body representation is editable.")
    original = reps[0]
    if (
        original.RepresentationType != "SweptSolid"
        or len(original.Items) != 1
        or not original.Items[0].is_a("IfcExtrudedAreaSolid")
    ):
        raise WallAuthoringError("Only straight extruded wall geometry is editable.")
    if len(model.get_inverse(original)) != 1:
        raise WallAuthoringError("Shared IFC wall representation cannot be replaced.")
    ifcopenshell.api.geometry.unassign_representation(
        model,
        product=wall,
        representation=original,
    )
    ifcopenshell.api.geometry.remove_representation(
        model,
        representation=original,
    )
    _create_body(model, wall, geometry)
    if wall.GlobalId != wall_global_id:
        raise WallAuthoringError("IFC GlobalId changed unexpectedly.")
    return model
