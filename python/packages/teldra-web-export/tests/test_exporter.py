from __future__ import annotations

import json

import ifcopenshell.api.aggregate
import ifcopenshell.api.geometry
import ifcopenshell.api.root
import ifcopenshell.api.spatial
from teldra_ifc import create_ifc4_project, write_model
from teldra_web_export import CANONICAL_TO_GLTF, export_ifc_web_scene, read_glb_json


def _model_with_wall():
    model, spine, contexts = create_ifc4_project("Web export fixture")
    storey = ifcopenshell.api.root.create_entity(
        model,
        ifc_class="IfcBuildingStorey",
        name="Ground Floor",
    )
    wall = ifcopenshell.api.root.create_entity(
        model,
        ifc_class="IfcWall",
        name="Export Wall",
    )

    ifcopenshell.api.aggregate.assign_object(
        model,
        relating_object=spine.building,
        products=[storey],
    )
    ifcopenshell.api.spatial.assign_container(
        model,
        relating_structure=storey,
        products=[wall],
    )

    representation = ifcopenshell.api.geometry.create_2pt_wall(
        model,
        element=wall,
        context=contexts.body,
        p1=(0.0, 0.0),
        p2=(3.0, 0.0),
        elevation=0.0,
        height=2.4,
        thickness=0.2,
        is_si=True,
    )
    ifcopenshell.api.geometry.assign_representation(
        model,
        product=wall,
        representation=representation,
    )

    return model, wall


def test_exports_glb_with_canonical_identity_and_manifest(tmp_path):
    model, wall = _model_with_wall()
    ifc_path = write_model(model, tmp_path / "building.ifc")
    glb_path = tmp_path / "scene.glb"
    manifest_path = tmp_path / "scene.manifest.json"

    result = export_ifc_web_scene(
        ifc_path,
        glb_path,
        manifest_path,
        canonical_by_global_id={wall.GlobalId: "wall:export"},
    )

    assert result.mapped_node_count >= 1
    assert result.glb_path == glb_path
    assert result.manifest_path == manifest_path

    document = read_glb_json(glb_path)
    teldra_metadata = [
        node.get("extras", {}).get("teldra")
        for node in document["nodes"]
        if isinstance(node, dict)
        and isinstance(node.get("extras"), dict)
        and isinstance(node["extras"].get("teldra"), dict)
    ]

    assert any(
        metadata["canonicalId"] == "wall:export"
        and metadata["ifcGlobalId"] == wall.GlobalId
        and metadata["nodeKey"].startswith(f"ifc:{wall.GlobalId}:body")
        for metadata in teldra_metadata
    )

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["scene"]["canonicalToScene"] == list(CANONICAL_TO_GLTF)
    assert manifest["coordinateSystem"] == {
        "unit": "metre",
        "handedness": "right",
        "upAxis": "Z",
    }
    assert {node["canonicalId"] for node in manifest["nodes"]} == {"wall:export"}
    assert all(node["ifcGlobalId"] == wall.GlobalId for node in manifest["nodes"])
    assert len(manifest["source"]["buildingSha256"]) == 64
    assert len(manifest["scene"]["assetSha256"]) == 64


def test_fails_when_requested_ifc_identity_is_not_in_serialized_scene(tmp_path):
    model, _ = _model_with_wall()
    ifc_path = write_model(model, tmp_path / "building.ifc")

    try:
        export_ifc_web_scene(
            ifc_path,
            tmp_path / "scene.glb",
            tmp_path / "scene.manifest.json",
            canonical_by_global_id={
                "3ZYNKvi3P3FvKPBGP9UP7n": "wall:missing",
            },
        )
    except Exception as error:
        assert "did not expose mapped IFC elements" in str(error)
    else:
        raise AssertionError("Expected exporter to reject an unmapped IFC GlobalId.")
