"""Every committed IFC fixture must be schema-valid (issue #163).

web-ifc tolerates malformed GlobalIds (the connected-walls fixture once carried
21/23/24-character ids); IfcOpenShell's express validation does not.
"""

from __future__ import annotations

from pathlib import Path

import ifcopenshell
import ifcopenshell.validate
import pytest

ROOT = Path(__file__).parents[4]
FIXTURES = sorted(
    [*(ROOT / "fixtures" / "ifc").rglob("*.ifc"), *(ROOT / "fixtures" / "projects").rglob("*.ifc")]
)


class _Collector:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def error(self, message="", *args, **kwargs) -> None:
        self.errors.append(str(message))

    def warning(self, *args, **kwargs) -> None: ...
    def info(self, *args, **kwargs) -> None: ...
    def debug(self, *args, **kwargs) -> None: ...
    def log(self, *args, **kwargs) -> None: ...


def test_fixture_discovery_is_not_vacuous() -> None:
    names = {path.parent.name for path in FIXTURES}
    assert {"connected-walls", "golden-home"} <= names


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.parent.name)
def test_committed_ifc_fixture_validates_with_express_rules(path: Path) -> None:
    model = ifcopenshell.open(str(path))
    collector = _Collector()
    ifcopenshell.validate.validate(model, collector, express_rules=True)
    assert collector.errors == []
    for entity in model.by_type("IfcRoot"):
        assert len(entity.GlobalId) == 22, (path.name, entity.GlobalId)
