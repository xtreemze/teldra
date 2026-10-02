from __future__ import annotations

import pytest
from teldra_ifc import IfcIdentityError, create_ifc4_home, resolve_global_id


def test_resolve_global_id_rejects_missing_identity() -> None:
    model, _ = create_ifc4_home()

    with pytest.raises(IfcIdentityError, match="was not found"):
        resolve_global_id(model, "0000000000000000000000")


def test_resolve_global_id_rejects_unexpected_ifc_class() -> None:
    model, ids = create_ifc4_home()

    with pytest.raises(IfcIdentityError, match="not expected class IfcDoor"):
        resolve_global_id(model, ids.wall, expected_class="IfcDoor")


def test_global_ids_are_ifc_compressed_identifiers() -> None:
    _, ids = create_ifc4_home()

    for global_id in (
        ids.project,
        ids.site,
        ids.building,
        ids.storey,
        ids.space,
        ids.wall,
    ):
        assert len(global_id) == 22
