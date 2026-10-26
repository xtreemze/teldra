from __future__ import annotations

import hashlib
import json
import runpy
from pathlib import Path
from zipfile import ZipFile

import pytest

ROOT = Path(__file__).parents[4]
convert = runpy.run_path(str(ROOT / "tools/import/sh3d_to_project.py"))["convert"]


def test_conversion_packages_verified_ifc_scene_and_explicit_loss_report(tmp_path) -> None:
    source = tmp_path / "source.sh3d"
    with ZipFile(source, "w") as archive:
        archive.writestr("Home.xml", (ROOT / "fixtures/sh3d/golden-home/Home.xml").read_bytes())
    before = source.read_bytes()
    destination = tmp_path / "converted.teldra"

    report = convert(source, destination)

    assert source.read_bytes() == before
    assert report["mappedSourceIdentities"] == 9
    assert report["renderableSourceIdentities"] == 4
    assert report["warnings"]
    with ZipFile(destination) as archive:
        manifest = json.loads(archive.read("project.json"))
        artifacts = [manifest["building"], manifest["twin"], *manifest["derived"]]
        for artifact in artifacts:
            assert hashlib.sha256(archive.read(artifact["path"])).hexdigest() == artifact["sha256"]
        scene = json.loads(archive.read("scene.manifest.json"))
        assert len(scene["nodes"]) == 4
        twin = json.loads(archive.read("twin.json"))
        assert len(twin["building"]["refs"]) == 9
        assert twin["devices"] == twin["bindings"] == []
        assert json.loads(archive.read("import-report.json")) == report
        assert {node["canonicalId"] for node in scene["nodes"]} <= {
            ref["id"] for ref in twin["building"]["refs"]
        }

    original = destination.read_bytes()
    with pytest.raises(FileExistsError):
        convert(source, destination)
    assert destination.read_bytes() == original


def test_invalid_source_does_not_publish_a_project(tmp_path) -> None:
    source = tmp_path / "broken.sh3d"
    source.write_bytes(b"not a zip")
    destination = tmp_path / "converted.teldra"
    with pytest.raises(ValueError, match="ZIP"):
        convert(source, destination)
    assert not destination.exists()


def test_visual_export_receipt_must_match_original_source(tmp_path) -> None:
    source = tmp_path / "source.sh3d"
    with ZipFile(source, "w") as archive:
        archive.writestr("Home.xml", (ROOT / "fixtures/sh3d/golden-home/Home.xml").read_bytes())
    visual = tmp_path / "visuals"
    visual.mkdir()
    (visual / "visual-export.json").write_text(
        json.dumps(
            {
                "sourceSha256": "wrong",
                "xmlOnly": True,
            }
        )
    )
    destination = tmp_path / "out.teldra"
    with pytest.raises(ValueError, match="does not match"):
        convert(source, destination, visual_export=visual)
    assert not destination.exists()
