from __future__ import annotations

import json
from pathlib import Path

from teldra_ifc import open_model, write_model
from teldra_import_sh3d import import_home_to_ifc
from teldra_sh3d import parse_home_xml
from teldra_web_export import export_ifc_web_scene, read_glb_json

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
GOLDEN_HOME_XML = REPOSITORY_ROOT / "fixtures" / "sh3d" / "golden-home" / "Home.xml"
SOURCE_KEY = "wall:wall0"
CANONICAL_ID = "wall:golden-home:wall0"


def test_golden_home_preserves_identity_from_sh3d_through_web_export(tmp_path: Path) -> None:
    home = parse_home_xml(GOLDEN_HOME_XML.read_bytes())

    first_import = import_home_to_ifc(home)
    first_global_id = first_import.source_to_global_id[SOURCE_KEY]
    first_ifc = write_model(first_import.model, tmp_path / "first.ifc")

    persisted = open_model(first_ifc)
    second_import = import_home_to_ifc(home, existing_model=persisted)
    second_global_id = second_import.source_to_global_id[SOURCE_KEY]

    assert second_global_id == first_global_id

    canonical_by_global_id = {second_global_id: CANONICAL_ID}
    second_ifc = write_model(second_import.model, tmp_path / "building.ifc")
    result = export_ifc_web_scene(
        second_ifc,
        tmp_path / "scene.glb",
        tmp_path / "scene.manifest.json",
        canonical_by_global_id=canonical_by_global_id,
    )

    assert result.mapped_node_count >= 1

    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    manifest_nodes = [
        node
        for node in manifest["nodes"]
        if node["ifcGlobalId"] == second_global_id
    ]

    assert manifest_nodes
    assert {node["canonicalId"] for node in manifest_nodes} == {CANONICAL_ID}
    assert all(node["nodeKey"].startswith(f"ifc:{second_global_id}:") for node in manifest_nodes)

    glb = read_glb_json(result.glb_path)
    glb_identities = [
        node["extras"]["teldra"]
        for node in glb["nodes"]
        if isinstance(node, dict)
        and isinstance(node.get("extras"), dict)
        and isinstance(node["extras"].get("teldra"), dict)
        and node["extras"]["teldra"].get("ifcGlobalId") == second_global_id
    ]

    assert glb_identities
    assert {identity["canonicalId"] for identity in glb_identities} == {CANONICAL_ID}
    assert {
        identity["nodeKey"]
        for identity in glb_identities
    } == {
        node["nodeKey"]
        for node in manifest_nodes
    }
