from __future__ import annotations

import hashlib
import json
from pathlib import Path

import ifcopenshell

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
PROJECT_DIR = REPOSITORY_ROOT / "fixtures" / "projects" / "golden-home"
BUILDING_IFC = PROJECT_DIR / "building.ifc"


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_golden_project_manifest_hashes_checked_in_artifacts() -> None:
    project = _json(PROJECT_DIR / "project.json")

    assert project["building"] == {
        "path": "building.ifc",
        "sha256": _sha256(PROJECT_DIR / "building.ifc"),
    }
    assert project["twin"] == {
        "path": "twin.json",
        "sha256": _sha256(PROJECT_DIR / "twin.json"),
    }

    for artifact in project["derived"]:
        assert artifact["sha256"] == _sha256(PROJECT_DIR / artifact["path"])


def test_golden_ifc_covers_required_semantics_and_source_identity() -> None:
    model = ifcopenshell.open(str(BUILDING_IFC))
    identity = _json(PROJECT_DIR / "identity-map.json")

    expected_classes = {
        "level:level0": "IfcBuildingStorey",
        "room:room0": "IfcSpace",
        "wall:wall0": "IfcWall",
        "wall:wall1": "IfcWall",
        "wall:wall2": "IfcWall",
        "wall:wall3": "IfcWall",
        "pieceOfFurniture:chair0": "IfcFurniture",
        "doorOrWindow:door0": "IfcBuildingElementProxy",
        "light:light0": "IfcLightFixture",
    }

    by_source = {entry["sourceKey"]: entry for entry in identity["entries"]}
    assert set(by_source) == set(expected_classes)

    for source_key, expected_class in expected_classes.items():
        entry = by_source[source_key]
        entity = model.by_guid(entry["ifcGlobalId"])
        assert entity is not None
        assert entity.is_a() == expected_class
        assert entity.GlobalId == entry["ifcGlobalId"]

    assert len(model.by_type("IfcOpeningElement")) == 1
    assert all(wall.Representation is not None for wall in model.by_type("IfcWall"))

    for source_key in [
        "level:level0",
        "pieceOfFurniture:chair0",
        "doorOrWindow:door0",
        "light:light0",
    ]:
        entity = model.by_guid(by_source[source_key]["ifcGlobalId"])
        assert entity.ObjectPlacement is not None


def test_golden_twin_and_scene_resolve_through_identity_map() -> None:
    identity = _json(PROJECT_DIR / "identity-map.json")
    twin = _json(PROJECT_DIR / "twin.json")
    scene = _json(PROJECT_DIR / "scene.manifest.json")

    canonical_to_ifc = {entry["canonicalId"]: entry["ifcGlobalId"] for entry in identity["entries"]}

    twin_refs = {ref["id"]: ref["ifcGlobalId"] for ref in twin["building"]["refs"]}
    assert twin_refs == {
        "space:living-room": canonical_to_ifc["space:living-room"],
        "fixture:living-room-floor-lamp": canonical_to_ifc["fixture:living-room-floor-lamp"],
    }

    scene_building = {
        node["canonicalId"]: node["ifcGlobalId"]
        for node in scene["nodes"]
        if node["kind"] == "building"
    }

    for canonical_id, ifc_global_id in twin_refs.items():
        assert scene_building[canonical_id] == ifc_global_id


def test_fixture_corpus_is_synthetic_and_declares_invariants() -> None:
    corpus = _json(REPOSITORY_ROOT / "fixtures" / "corpus.json")

    assert corpus["policy"]["containsRealUserData"] is False
    assert corpus["fixtures"]

    for fixture in corpus["fixtures"]:
        assert fixture["paths"]
        assert fixture["provenance"]
        assert fixture["license"]
        assert fixture["invariants"]
        for relative_path in fixture["paths"]:
            assert (REPOSITORY_ROOT / relative_path).exists()
