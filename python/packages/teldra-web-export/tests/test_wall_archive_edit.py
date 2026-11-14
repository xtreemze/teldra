from __future__ import annotations

import hashlib
import json
import runpy
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile

import ifcopenshell
import pytest
from teldra_ifc import StraightWall, create_ifc4_home, create_straight_wall
from teldra_web_export import export_ifc_web_scene

EDIT_SCRIPT = Path(__file__).parents[4] / "tools" / "import" / "edit_wall_project.py"
MODULE = runpy.run_path(str(EDIT_SCRIPT))
edit_wall_archive_copy = MODULE["edit_wall_archive_copy"]
WallArchiveEditError = MODULE["WallArchiveEditError"]


def _json(data):
    return (json.dumps(data, sort_keys=True) + "\n").encode()


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _fixture(tmp_path: Path) -> tuple[Path, str, str]:
    model, ids = create_ifc4_home()
    model, wall_guid = create_straight_wall(
        model,
        ids.storey,
        StraightWall((0, 0), (4, 0), 0.2, 2.6),
    )
    ifc = tmp_path / "building.ifc"
    model.write(str(ifc))
    export_ifc_web_scene(
        ifc,
        tmp_path / "building.glb",
        tmp_path / "scene.manifest.json",
        canonical_by_global_id={wall_guid: f"ifc:{wall_guid}"},
    )
    twin = _json(
        {
            "schemaVersion": "0.1.0",
            "building": {
                "ifcSchema": "IFC4",
                "refs": [
                    {
                        "id": f"ifc:{wall_guid}",
                        "ifcGlobalId": wall_guid,
                        "kind": "wall",
                        "name": "Wall",
                    },
                    {
                        "id": "storey:1",
                        "ifcGlobalId": ids.storey,
                        "kind": "storey",
                        "name": "Ground",
                    },
                ],
            },
            "devices": [],
            "bindings": [],
        }
    )
    entries = {
        "building.ifc": ifc.read_bytes(),
        "building.glb": (tmp_path / "building.glb").read_bytes(),
        "scene.manifest.json": (tmp_path / "scene.manifest.json").read_bytes(),
        "twin.json": twin,
    }

    def artifact(path):
        return {"path": path, "sha256": _hash(entries[path])}

    entries["project.json"] = _json(
        {
            "formatVersion": "0.1.0",
            "building": artifact("building.ifc"),
            "twin": artifact("twin.json"),
            "derived": [artifact("scene.manifest.json"), artifact("building.glb")],
        }
    )
    archive = tmp_path / "fixture.teldra"
    with ZipFile(archive, "w", compression=ZIP_STORED) as dest:
        for path, data in entries.items():
            dest.writestr(path, data)
    return archive, ids.storey, wall_guid


def test_archive_wall_edit_rebuilds_and_reopens_consistent_ifc_scene(tmp_path):
    source, _, guid = _fixture(tmp_path)
    original_bytes = source.read_bytes()
    output = tmp_path / "edited.teldra"
    assert (
        edit_wall_archive_copy(
            source,
            output,
            wall_global_id=guid,
            wall=StraightWall((0, 0), (5, 0), 0.3, 2.8),
        )
        == guid
    )
    assert source.read_bytes() == original_bytes
    with ZipFile(output) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    manifest = json.loads(entries["project.json"])
    scene = json.loads(entries["scene.manifest.json"])
    for a in [manifest["building"], manifest["twin"], *manifest["derived"]]:
        assert a["sha256"] == _hash(entries[a["path"]])
    assert scene["source"]["buildingSha256"] == _hash(entries["building.ifc"])
    assert scene["scene"]["assetSha256"] == _hash(entries["building.glb"])
    model = ifcopenshell.file.from_string(entries["building.ifc"].decode())
    assert model.by_guid(guid).Representation is not None
    assert guid in {n["ifcGlobalId"] for n in scene["nodes"]}


def test_archive_wall_creation_adds_authored_twin_ref_and_derived_mesh(tmp_path):
    source, storey, _ = _fixture(tmp_path)
    output = tmp_path / "created.teldra"
    guid = edit_wall_archive_copy(
        source,
        output,
        storey_global_id=storey,
        wall=StraightWall((5, 0), (5, 4), 0.15, 2.6),
        name="Added wall",
    )
    with ZipFile(output) as archive:
        twin = json.loads(archive.read("twin.json"))
        model = ifcopenshell.file.from_string(archive.read("building.ifc").decode())
        scene = json.loads(archive.read("scene.manifest.json"))
    assert model.by_guid(guid).is_a("IfcWall")
    assert any(r["ifcGlobalId"] == guid and r["kind"] == "wall" for r in twin["building"]["refs"])
    assert any(n["ifcGlobalId"] == guid for n in scene["nodes"])


def test_archives_with_native_visuals_are_rejected_without_data_loss(tmp_path):
    source, storey, _ = _fixture(tmp_path)
    visual = tmp_path / "native.teldra"
    with ZipFile(source) as inp, ZipFile(visual, "w") as out:
        for name in inp.namelist():
            out.writestr(name, inp.read(name))
        out.writestr("source.sh3d", b"source project")
    output = tmp_path / "native-edited.teldra"
    before = visual.read_bytes()
    with pytest.raises(WallArchiveEditError, match="cannot yet be regenerated"):
        edit_wall_archive_copy(
            visual,
            output,
            storey_global_id=storey,
            wall=StraightWall((5, 0), (5, 4), 0.1, 2.6),
        )
    assert visual.read_bytes() == before
    assert not output.exists()


def test_invalid_archive_references_and_existing_destination_fail_closed(tmp_path):
    source, storey, wall_id = _fixture(tmp_path)
    with pytest.raises(WallArchiveEditError, match="overwrite"):
        edit_wall_archive_copy(
            source,
            source,
            wall_global_id=wall_id,
            wall=StraightWall((0, 0), (4, 0), 0.2, 2.6),
        )
    broken = tmp_path / "broken.teldra"
    with ZipFile(source) as inp, ZipFile(broken, "w") as out:
        for name in inp.namelist():
            data = inp.read(name)
            if name == "building.ifc":
                data = b"garbage"
            out.writestr(name, data)
    output = tmp_path / "no-write.teldra"
    with pytest.raises(WallArchiveEditError, match="hash"):
        edit_wall_archive_copy(
            broken,
            output,
            storey_global_id=storey,
            wall=StraightWall((0, 0), (4, 0), 0.2, 2.6),
        )
    assert not output.exists()
