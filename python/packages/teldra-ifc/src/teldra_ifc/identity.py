from __future__ import annotations

import ifcopenshell


class IfcIdentityError(LookupError):
    """Raised when canonical IFC identity cannot be resolved as requested."""


def resolve_global_id(
    model: ifcopenshell.file,
    global_id: str,
    *,
    expected_class: str | None = None,
) -> ifcopenshell.entity_instance:
    """Resolve a rooted IFC entity without replacing its canonical GlobalId."""

    try:
        entity = model.by_guid(global_id)
    except (RuntimeError, ValueError) as error:
        raise IfcIdentityError(f'IFC GlobalId "{global_id}" was not found.') from error

    if entity is None:
        raise IfcIdentityError(f'IFC GlobalId "{global_id}" was not found.')

    if expected_class is not None and not entity.is_a(expected_class):
        raise IfcIdentityError(
            f'IFC GlobalId "{global_id}" resolves to {entity.is_a()}, '
            f"not expected class {expected_class}."
        )

    return entity
