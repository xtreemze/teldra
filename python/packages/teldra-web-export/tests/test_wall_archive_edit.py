from __future__ import annotations

import hashlib
import json
import runpy
import subprocess
import sys
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile

import ifcopenshell
import pytest
from teldra_ifc import StraightWall, create_ifc4_home, create_straight_wall
from teldra_web_export import export_ifc_web_scene

EDIT_SCRIPT = Path(__file__).parents[4] / "tools" / "import" / "edit_wall_project.py"
MODULE = runpy.run_path(str(EDIT_SCRIPT))
edit_wall_archive_copy = MODULE["edit_wall_archive_copy"]
read_wall_draft_json = MODULE["read_wall_draft_json"]
read_wall_edit_draft_json = MODULE["read_wall_edit_draft_json"]
inspect_wall_archive = MODULE["inspect_wall_archive"]
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


def test_studio_wall_draft_json_roundtrip_and_rejects_wrong_contract(tmp_path):
    draft = tmp_path / "draft.json"
    intent = {
        "format": "teldra-wall-draft-v1",
        "operation": "CreateWall",
        "coordinateFrame": "ifc-world-metres-z-up",
        "wall": {
            "start": [0, 0],
            "end": [3.5, 0],
            "thicknessMetres": 0.15,
            "heightMetres": 2.7,
        },
    }
    draft.write_text(json.dumps(intent), encoding="utf-8")
    parsed = read_wall_draft_json(draft)
    assert parsed == StraightWall((0, 0), (3.5, 0), 0.15, 2.7)

    source, storey, _ = _fixture(tmp_path)
    output = tmp_path / "reviewed-draft.teldra"
    guid = edit_wall_archive_copy(source, output, storey_global_id=storey, wall=parsed)
    with ZipFile(output) as archive:
        model = ifcopenshell.file.from_string(archive.read("building.ifc").decode())
    assert model.by_guid(guid).is_a("IfcWall")

    for key, value in [
        ("format", "unknown-draft"),
        ("operation", "DeleteWall"),
        ("coordinateFrame", "unknown"),
    ]:
        invalid = {**intent, key: value}
        draft.write_text(json.dumps(invalid), encoding="utf-8")
        with pytest.raises(WallArchiveEditError, match="Unsupported"):
            read_wall_draft_json(draft)
    invalid = {**intent, "wall": {**intent["wall"], "start": [True, 0]}}
    draft.write_text(json.dumps(invalid), encoding="utf-8")
    with pytest.raises(WallArchiveEditError, match="numeric"):
        read_wall_draft_json(draft)


def test_wall_archive_source_fingerprint_guards_reviewed_input(tmp_path):
    source, storey, _ = _fixture(tmp_path)
    approved = _hash(source.read_bytes())
    output = tmp_path / "matching-source.teldra"
    guid = edit_wall_archive_copy(
        source,
        output,
        storey_global_id=storey,
        wall=StraightWall((5, 0), (5, 3), 0.2, 2.6),
        expected_source_sha256=approved,
    )
    assert guid
    assert output.exists()

    changed = tmp_path / "changed-source.teldra"
    with ZipFile(source) as archive, ZipFile(changed, "w", compression=ZIP_STORED) as dest:
        for filename in archive.namelist():
            dest.writestr(filename, archive.read(filename))
        dest.writestr("irrelevant-note.txt", b"changed since human review")
    rejected = tmp_path / "must-not-exist.teldra"
    with pytest.raises(WallArchiveEditError, match="changed since review"):
        edit_wall_archive_copy(
            changed,
            rejected,
            storey_global_id=storey,
            wall=StraightWall((5, 0), (5, 3), 0.2, 2.6),
            expected_source_sha256=approved,
        )
    assert not rejected.exists()
    with pytest.raises(WallArchiveEditError, match="64 lowercase hex"):
        edit_wall_archive_copy(
            source,
            rejected,
            storey_global_id=storey,
            wall=StraightWall((5, 0), (5, 3), 0.2, 2.6),
            expected_source_sha256="not-a-sha",
        )
    assert not rejected.exists()


def test_wall_archive_preflight_reports_exact_source_and_ifc_storeys(tmp_path):
    source, storey, wall_guid = _fixture(tmp_path)
    unchanged = source.read_bytes()
    report = inspect_wall_archive(source)
    assert report["eligible"] is True
    assert report["sourceSha256"] == _hash(unchanged)
    assert report["ifcSchema"] == "IFC4"
    assert report["storeys"] == [{"ifcGlobalId": storey, "name": "Ground Floor"}]
    assert report["buildingReferences"] == 2
    assert report["walls"] == [
        {
            "canonicalId": f"ifc:{wall_guid}",
            "ifcGlobalId": wall_guid,
            "name": "Wall",
            "editable": True,
            "blockedReason": None,
            "deletable": False,
            "deleteBlockedReason": "Cannot remove the last renderable building object.",
        }
    ]
    assert source.read_bytes() == unchanged
    assert sorted(path.name for path in tmp_path.glob("*.teldra")) == [source.name]

    out = tmp_path / "created-after-preflight.teldra"
    edit_wall_archive_copy(
        source,
        out,
        storey_global_id=report["storeys"][0]["ifcGlobalId"],
        wall=StraightWall((5, 0), (8, 0), 0.15, 2.6),
        expected_source_sha256=report["sourceSha256"],
    )
    assert out.exists()


def test_wall_archive_preflight_rejects_native_visuals_and_corrupt_archives(tmp_path):
    source, _, _ = _fixture(tmp_path)
    visual = tmp_path / "native-with-materials.teldra"
    with ZipFile(source) as original, ZipFile(visual, "w") as output:
        for name in original.namelist():
            output.writestr(name, original.read(name))
        output.writestr("visual-export.json", b"{}")
    with pytest.raises(WallArchiveEditError, match="cannot yet be regenerated"):
        inspect_wall_archive(visual)

    corrupted = tmp_path / "corrupt.teldra"
    with ZipFile(source) as original, ZipFile(corrupted, "w") as output:
        for name in original.namelist():
            payload = original.read(name)
            output.writestr(name, b"invalid" if name == "building.ifc" else payload)
    with pytest.raises(WallArchiveEditError, match="hash"):
        inspect_wall_archive(corrupted)

    dangling = tmp_path / "dangling-ref.teldra"
    with ZipFile(source) as original:
        entries = {name: original.read(name) for name in original.namelist()}
    twin = json.loads(entries["twin.json"])
    twin["building"]["refs"][0]["ifcGlobalId"] = "0" * 22
    entries["twin.json"] = _json(twin)
    project = json.loads(entries["project.json"])
    project["twin"]["sha256"] = _hash(entries["twin.json"])
    entries["project.json"] = _json(project)
    with ZipFile(dangling, "w", compression=ZIP_STORED) as output:
        for name, data in entries.items():
            output.writestr(name, data)
    with pytest.raises(WallArchiveEditError, match="Unresolved authored building reference"):
        inspect_wall_archive(dangling)


def test_wall_edit_publishes_a_verified_archive_copy_without_mutating_original(tmp_path):
    source, storey, _ = _fixture(tmp_path)
    original = source.read_bytes()
    destination = tmp_path / "atomically-published.teldra"
    guid = edit_wall_archive_copy(
        source,
        destination,
        storey_global_id=storey,
        wall=StraightWall((6, 0), (6, 4), 0.2, 2.6),
        expected_source_sha256=_hash(original),
    )
    assert source.read_bytes() == original
    with ZipFile(destination) as archive:
        assert archive.testzip() is None
        model = ifcopenshell.file.from_string(archive.read("building.ifc").decode())
        scene = json.loads(archive.read("scene.manifest.json"))
        manifest = json.loads(archive.read("project.json"))
        entries = {name: archive.read(name) for name in archive.namelist()}
    assert model.by_guid(guid).is_a("IfcWall")
    assert any(node["ifcGlobalId"] == guid for node in scene["nodes"])
    assert all(
        item["sha256"] == _hash(entries[item["path"]])
        for item in (manifest["building"], manifest["twin"], *manifest["derived"])
    )
    with pytest.raises(WallArchiveEditError, match="overwrite"):
        edit_wall_archive_copy(
            source,
            destination,
            storey_global_id=storey,
            wall=StraightWall((7, 0), (7, 4), 0.2, 2.6),
        )


def test_corrupted_rebuilt_scene_is_never_published(tmp_path, monkeypatch):
    source, storey, _ = _fixture(tmp_path)
    destination = tmp_path / "must-not-be-published.teldra"
    original = source.read_bytes()
    writer_globals = edit_wall_archive_copy.__globals__
    real_export = writer_globals["export_ifc_web_scene"]

    def corrupt_export(ifc_path, glb_path, manifest_path, *, canonical_by_global_id):
        real_export(
            ifc_path,
            glb_path,
            manifest_path,
            canonical_by_global_id=canonical_by_global_id,
        )
        scene = json.loads(manifest_path.read_text(encoding="utf-8"))
        scene["source"]["buildingSha256"] = "0" * 64
        manifest_path.write_text(json.dumps(scene), encoding="utf-8")

    monkeypatch.setitem(writer_globals, "export_ifc_web_scene", corrupt_export)
    with pytest.raises(WallArchiveEditError, match="provenance"):
        edit_wall_archive_copy(
            source,
            destination,
            storey_global_id=storey,
            wall=StraightWall((6, 0), (6, 4), 0.2, 2.6),
        )
    assert source.read_bytes() == original
    assert not destination.exists()


def test_wall_removal_rebuilds_verified_architecture_only_copy(tmp_path):
    source, storey, guid = _fixture(tmp_path)
    before = source.read_bytes()
    populated = tmp_path / "two-walls.teldra"
    second_guid = edit_wall_archive_copy(
        source,
        populated,
        storey_global_id=storey,
        wall=StraightWall((6, 0), (6, 4), 0.2, 2.6),
        expected_source_sha256=_hash(before),
    )
    populated_before = populated.read_bytes()
    eligibility = inspect_wall_archive(populated)
    candidates = {wall["ifcGlobalId"]: wall for wall in eligibility["walls"]}
    assert candidates[guid]["deletable"] is True
    assert candidates[guid]["deleteBlockedReason"] is None
    assert candidates[second_guid]["deletable"] is True
    output = tmp_path / "removed-wall.teldra"
    assert (
        edit_wall_archive_copy(
            populated,
            output,
            delete_wall_global_id=guid,
            expected_source_sha256=_hash(populated_before),
        )
        == guid
    )
    assert source.read_bytes() == before
    assert populated.read_bytes() == populated_before
    with ZipFile(output) as archive:
        assert archive.testzip() is None
        twin = json.loads(archive.read("twin.json"))
        scene = json.loads(archive.read("scene.manifest.json"))
        model = ifcopenshell.file.from_string(archive.read("building.ifc").decode())
        project = json.loads(archive.read("project.json"))
        entries = {name: archive.read(name) for name in archive.namelist()}
    assert any(wall.GlobalId == second_guid for wall in model.by_type("IfcWall"))
    assert not any(wall.GlobalId == guid for wall in model.by_type("IfcWall"))
    assert not any(ref["ifcGlobalId"] == guid for ref in twin["building"]["refs"])
    assert not any(node["ifcGlobalId"] == guid for node in scene["nodes"])
    assert all(
        artifact["sha256"] == _hash(entries[artifact["path"]])
        for artifact in (project["building"], project["twin"], *project["derived"])
    )


def test_wall_removal_refuses_last_renderable_object_without_output(tmp_path):
    source, _, guid = _fixture(tmp_path)
    destination = tmp_path / "would-be-empty.teldra"
    before = source.read_bytes()
    with pytest.raises(WallArchiveEditError, match="last renderable"):
        edit_wall_archive_copy(
            source,
            destination,
            delete_wall_global_id=guid,
        )
    assert source.read_bytes() == before
    assert not destination.exists()


def test_wall_removal_rejects_invalid_targets_and_native_visuals(tmp_path):
    source, storey, guid = _fixture(tmp_path)
    bad = tmp_path / "no-delete.teldra"
    with pytest.raises(WallArchiveEditError, match="geometry"):
        edit_wall_archive_copy(
            source,
            bad,
            delete_wall_global_id=guid,
            wall=StraightWall((0, 0), (4, 0), 0.2, 2.6),
        )
    with pytest.raises(WallArchiveEditError, match="uniquely authored"):
        edit_wall_archive_copy(source, bad, delete_wall_global_id=storey)
    assert not bad.exists()

    native = tmp_path / "native-with-source.teldra"
    with ZipFile(source) as original, ZipFile(native, "w") as destination:
        for filename in original.namelist():
            destination.writestr(filename, original.read(filename))
        destination.writestr("source.sh3d", b"untouched source")
    with pytest.raises(WallArchiveEditError, match="cannot yet be regenerated"):
        edit_wall_archive_copy(native, bad, delete_wall_global_id=guid)
    assert not bad.exists()


def test_wall_deletion_rejects_twin_device_reference_without_creating_output(tmp_path):
    source, storey, guid = _fixture(tmp_path)
    populated = tmp_path / "two-walls-for-binding.teldra"
    edit_wall_archive_copy(
        source,
        populated,
        storey_global_id=storey,
        wall=StraightWall((6, 0), (6, 4), 0.2, 2.6),
    )
    with ZipFile(populated) as original:
        entries = {name: original.read(name) for name in original.namelist()}
    twin = json.loads(entries["twin.json"])
    twin["devices"].append(
        {
            "id": "device:wall-sensor",
            "name": "Wall sensor",
            "buildingRefId": f"ifc:{guid}",
            "capabilities": [{"id": "cap:temperature", "kind": "sensor"}],
        }
    )
    entries["twin.json"] = _json(twin)
    project = json.loads(entries["project.json"])
    project["twin"]["sha256"] = _hash(entries["twin.json"])
    entries["project.json"] = _json(project)
    referenced = tmp_path / "device-referenced-wall.teldra"
    with ZipFile(referenced, "w", compression=ZIP_STORED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    before = referenced.read_bytes()
    report = inspect_wall_archive(referenced)
    target = next(wall for wall in report["walls"] if wall["ifcGlobalId"] == guid)
    assert target["editable"] is True
    assert target["deletable"] is False
    assert "device still references" in target["deleteBlockedReason"]
    destination = tmp_path / "rejected-wall-delete.teldra"
    with pytest.raises(WallArchiveEditError, match="referenced by a Teldra device"):
        edit_wall_archive_copy(
            referenced,
            destination,
            delete_wall_global_id=guid,
            expected_source_sha256=_hash(before),
        )
    assert referenced.read_bytes() == before
    assert not destination.exists()


def test_versioned_selected_wall_edit_draft_roundtrips_through_cli(tmp_path):
    source, _, guid = _fixture(tmp_path)
    reviewed_sha = _hash(source.read_bytes())
    handoff = tmp_path / "selected-wall-edit.json"
    handoff.write_text(
        json.dumps(
            {
                "format": "teldra-wall-edit-v1",
                "operation": "EditWall",
                "coordinateFrame": "ifc-world-metres-z-up",
                "targetIfcGlobalId": guid,
                "wall": {
                    "start": [1, 0],
                    "end": [7, 0],
                    "thicknessMetres": 0.25,
                    "heightMetres": 2.9,
                },
            }
        ),
        encoding="utf-8",
    )
    selected, geometry = read_wall_edit_draft_json(handoff)
    assert selected == guid
    assert geometry.start == (1, 0)
    destination = tmp_path / "selected-wall-edited.teldra"
    outcome = subprocess.run(
        [
            sys.executable,
            str(EDIT_SCRIPT),
            str(source),
            str(destination),
            "--edit-draft-file",
            str(handoff),
            "--expected-source-sha256",
            reviewed_sha,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(outcome.stdout)["ifcGlobalId"] == guid
    assert _hash(source.read_bytes()) == reviewed_sha
    with ZipFile(destination) as archive:
        assert archive.testzip() is None
        assert guid in {
            node["ifcGlobalId"] for node in json.loads(archive.read("scene.manifest.json"))["nodes"]
        }
        ifc = ifcopenshell.file.from_string(archive.read("building.ifc").decode())
        assert ifc.by_guid(guid).Representation is not None


def test_selected_wall_edit_draft_fails_closed_on_invalid_identity_and_operations(tmp_path):
    source, _, guid = _fixture(tmp_path)
    handoff = tmp_path / "untrusted-wall-edit.json"
    base = {
        "format": "teldra-wall-edit-v1",
        "operation": "EditWall",
        "coordinateFrame": "ifc-world-metres-z-up",
        "targetIfcGlobalId": guid,
        "wall": {
            "start": [0, 0],
            "end": [4, 0],
            "thicknessMetres": 0.2,
            "heightMetres": 2.6,
        },
    }
    for change in (
        {"operation": "DeleteWall"},
        {"coordinateFrame": "screen-pixels"},
        {"targetIfcGlobalId": "wrong-id"},
        {"wall": {**base["wall"], "start": [True, 0]}},
        {"otherCommand": "DeleteAll"},
    ):
        handoff.write_text(json.dumps({**base, **change}), encoding="utf-8")
        with pytest.raises(WallArchiveEditError):
            read_wall_edit_draft_json(handoff)
    # A validly formatted unknown GUID is rejected by the actual IFC writer.
    handoff.write_text(json.dumps({**base, "targetIfcGlobalId": "0" * 22}), encoding="utf-8")
    selected, geometry = read_wall_edit_draft_json(handoff)
    destination = tmp_path / "must-not-exist.teldra"
    with pytest.raises(ValueError, match="IfcWall"):
        edit_wall_archive_copy(source, destination, wall_global_id=selected, wall=geometry)
    assert not destination.exists()
