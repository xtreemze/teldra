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
import ifcopenshell.api.material
import ifcopenshell.api.root
import ifcopenshell.api.spatial
import ifcopenshell.util.element
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


def _refresh_axis_and_layers(
    model: ifcopenshell.file,
    wall: ifcopenshell.entity_instance,
    geometry: StraightWall,
) -> None:
    """Keep an imported wall's Axis and layer-set usage consistent with its new Body."""
    axes = [
        r
        for r in (wall.Representation.Representations if wall.Representation else [])
        if r.RepresentationIdentifier == "Axis"
    ]
    if axes:
        context = axes[0].ContextOfItems
        ifcopenshell.api.geometry.unassign_representation(
            model, product=wall, representation=axes[0]
        )
        ifcopenshell.api.geometry.remove_representation(model, representation=axes[0])
        length = hypot(geometry.end[0] - geometry.start[0], geometry.end[1] - geometry.start[1])
        axis = ifcopenshell.api.geometry.add_axis_representation(
            model, context=context, axis=[(0.0, 0.0), (length, 0.0)]
        )
        ifcopenshell.api.geometry.assign_representation(model, product=wall, representation=axis)
    usage = ifcopenshell.util.element.get_material(wall)
    if usage is not None and usage.is_a("IfcMaterialLayerSetUsage"):
        layers = usage.ForLayerSet.MaterialLayers
        if len(layers) == 1 and abs(layers[0].LayerThickness - geometry.thickness_m) > 1e-9:
            # Layer sets are shared between walls: never edit one in place.
            layer_set = ifcopenshell.api.material.add_material_set(
                model,
                name=f"Wall {geometry.thickness_m * 1000:g} mm",
                set_type="IfcMaterialLayerSet",
            )
            layer = ifcopenshell.api.material.add_layer(
                model, layer_set=layer_set, material=layers[0].Material
            )
            ifcopenshell.api.material.edit_layer(
                model, layer=layer, attributes={"LayerThickness": geometry.thickness_m}
            )
            usage.ForLayerSet = layer_set


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


def _editable_wall_body(
    model: ifcopenshell.file,
    wall: ifcopenshell.entity_instance,
) -> ifcopenshell.entity_instance:
    """Exactly the topology/ownership gates used for actual wall edits."""
    for inverse in model.get_inverse(wall):
        if inverse.is_a("IfcRelVoidsElement"):
            raise WallAuthoringError(
                "A wall hosting an opening requires dependent opening updates."
            )
        if inverse.is_a("IfcRelConnectsElements") or inverse.is_a("IfcRelSpaceBoundary"):
            raise WallAuthoringError("Connected or space-boundary walls require topology updates.")
    all_reps = list(wall.Representation.Representations) if wall.Representation else []
    # An Axis (reference line) representation travels with the Body and is
    # regenerated on edit; any other extra representation is unsupported.
    reps = [r for r in all_reps if r.RepresentationIdentifier == "Body"]
    axes = [r for r in all_reps if r.RepresentationIdentifier == "Axis"]
    if len(reps) != 1 or len(axes) > 1 or len(reps) + len(axes) != len(all_reps):
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
    return original


def inspect_wall_edit_eligibility(
    source: ifcopenshell.file,
    wall_global_id: str,
) -> tuple[bool, str | None]:
    """Nonmutating eligibility gate; not permission to skip writer validation.

    This checks existing topology and representation only. The writer must still
    verify geometry, isolated source authority and source archive revision.
    """
    try:
        if source.schema != "IFC4":
            raise WallAuthoringError("Only IFC4 is supported for wall authoring.")
        if abs(ifcopenshell.util.unit.calculate_unit_scale(source) - 1.0) > 1e-12:
            raise WallAuthoringError("Only metre-based IFC models are currently writable.")
        wall = _wall_by_guid(source, wall_global_id)
        _body_context(source)
        _editable_wall_body(source, wall)
    except WallAuthoringError as error:
        return False, str(error)
    return True, None


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
    original = _editable_wall_body(model, wall)
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
    _refresh_axis_and_layers(model, wall, geometry)
    if wall.GlobalId != wall_global_id:
        raise WallAuthoringError("IFC GlobalId changed unexpectedly.")
    return model


def _assert_deletable_wall(
    model: ifcopenshell.file,
    wall: ifcopenshell.entity_instance,
) -> None:
    _editable_wall_body(model, wall)
    for relation in model.get_inverse(wall):
        # The API can safely dissolve the wall's own spatial containment.
        if relation.is_a("IfcRelContainedInSpatialStructure"):
            if relation.RelatingStructure is None:
                raise WallAuthoringError("Wall spatial containment is malformed.")
            continue
        raise WallAuthoringError(
            "Wall deletion requires dependent IFC relationship updates: " + relation.is_a()
        )


def inspect_wall_delete_eligibility(
    source: ifcopenshell.file,
    wall_global_id: str,
) -> tuple[bool, str | None]:
    """Nonmutating IFC-only preflight; archive-level empty-scene gate is separate."""
    try:
        if source.schema != "IFC4":
            raise WallAuthoringError("Only IFC4 is supported for wall deletion.")
        if abs(ifcopenshell.util.unit.calculate_unit_scale(source) - 1.0) > 1e-12:
            raise WallAuthoringError("Only metre-based IFC models are currently writable.")
        wall = _wall_by_guid(source, wall_global_id)
        _body_context(source)
        _assert_deletable_wall(source, wall)
    except WallAuthoringError as error:
        return False, str(error)
    return True, None


def delete_straight_wall(
    source: ifcopenshell.file,
    wall_global_id: str,
) -> ifcopenshell.file:
    """Remove a standalone, unhosted, straight IFC4 wall on an isolated model.

    A conservative inverse-relationship allowlist prevents deleting a wall that
    participates in unknown structural, group, type, boundary or connectivity
    contracts. Native SH3D visual projects are rejected by the archive caller.
    """
    model = _isolated_model(source)
    wall = _wall_by_guid(model, wall_global_id)
    _assert_deletable_wall(model, wall)
    ifcopenshell.api.root.remove_product(model, product=wall)
    if _find_global_id(model, wall_global_id) is not None:
        raise WallAuthoringError("IFC wall deletion did not remove its GlobalId.")
    return model
