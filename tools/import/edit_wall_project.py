"""Atomic *new-copy* IFC straight-wall edit for architecture-only .teldra archives.

This intentionally refuses source.SH3D/native visual projects: their material-rich
GLB cannot currently be regenerated losslessly from IFC alone.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile

import ifcopenshell

from teldra_ifc import StraightWall, create_straight_wall, edit_straight_wall
from teldra_web_export import export_ifc_web_scene


class WallArchiveEditError(ValueError):
    pass


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json(value: dict) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _archive_files(source: Path) -> dict[str, bytes]:
    with ZipFile(source) as archive:
        names = archive.namelist()
        if len(set(names)) != len(names) or len(names) > 256:
            raise WallArchiveEditError("Duplicate or excessive archive entries.")
        if any(
            not name or name.startswith("/") or "\\" in name or
            "/" in name or name in {".", ".."}
            for name in names
        ):
            raise WallArchiveEditError("Only flat, safe archive paths are supported.")
        total = sum(item.file_size for item in archive.infolist())
        if total > 1024 * 1024 * 1024:
            raise WallArchiveEditError("Archive exceeds safe uncompressed size.")
        return {name: archive.read(name) for name in names}


def _verify(entries: dict[str, bytes]) -> tuple[dict, dict]:
    for required in ("project.json", "building.ifc", "twin.json", "scene.manifest.json", "building.glb"):
        if required not in entries:
            raise WallArchiveEditError(f"Project archive missing {required}.")
    manifest = json.loads(entries["project.json"])
    twin = json.loads(entries["twin.json"])
    if manifest.get("formatVersion") != "0.1.0" or twin.get("schemaVersion") != "0.1.0":
        raise WallArchiveEditError("Unsupported project/twin format version.")
    artifacts = [manifest["building"], manifest["twin"], *manifest.get("derived", [])]
    for artifact in artifacts:
        name = artifact["path"]
        if name not in entries or artifact.get("sha256") != _digest(entries[name]):
            raise WallArchiveEditError(f"Invalid archive artifact hash: {name}.")
    scene = json.loads(entries["scene.manifest.json"])
    if scene.get("source", {}).get("buildingSha256") != _digest(entries["building.ifc"]):
        raise WallArchiveEditError("Scene provenance does not match canonical IFC.")
    if scene.get("scene", {}).get("assetSha256") != _digest(entries["building.glb"]):
        raise WallArchiveEditError("Scene GLB checksum does not match its manifest.")
    # Architecture-only IFC is the sole supported source for scene regeneration.
    if "source.sh3d" in entries or any(
        name in entries for name in ("visual-export.json", "scene-source.ifc")
    ) or "visualProducer" in json.loads(entries.get("import-report.json", b"{}")):
        raise WallArchiveEditError(
            "Native SH3D visual assets cannot yet be regenerated losslessly; edit refused."
        )
    if twin.get("building", {}).get("ifcSchema") != "IFC4":
        raise WallArchiveEditError("Only IFC4 twin archives can be edited.")
    return manifest, twin


def edit_wall_archive_copy(
    source: Path,
    destination: Path,
    *,
    wall: StraightWall,
    storey_global_id: str | None = None,
    wall_global_id: str | None = None,
    name: str = "Wall",
) -> str:
    """Create or edit one straight wall and rebuild an architecture-only .teldra.

    Exactly one of storey_global_id or wall_global_id must be supplied.
    New archive destination must not exist. The input is never modified.
    """
    if (storey_global_id is None) == (wall_global_id is None):
        raise WallArchiveEditError("Specify exactly one storey for create or wall for edit.")
    if source.resolve() == destination.resolve() or destination.exists():
        raise WallArchiveEditError("Refusing to overwrite any existing project archive.")
    entries = _archive_files(source)
    manifest, twin = _verify(entries)
    original_ifc = ifcopenshell.file.from_string(entries["building.ifc"].decode("utf-8"))
    if wall_global_id is not None:
        staged_ifc = edit_straight_wall(original_ifc, wall_global_id, wall)
        changed_guid = wall_global_id
    else:
        staged_ifc, changed_guid = create_straight_wall(
            original_ifc, storey_global_id, wall, name=name,
        )
        twin["building"]["refs"].append({
            "id": f"ifc:{changed_guid}",
            "ifcGlobalId": changed_guid,
            "kind": "wall",
            "name": name,
        })
    # Confirm every authored reference still resolves before deriving a scene.
    for ref in twin["building"]["refs"]:
        if staged_ifc.by_guid(ref["ifcGlobalId"]) is None:
            raise WallArchiveEditError(f"Unresolved authored object: {ref['id']}")
    with tempfile.TemporaryDirectory(dir=destination.parent) as tmp:
        staging = Path(tmp)
        (staging / "building.ifc").write_text(staged_ifc.to_string(), encoding="utf-8")
        canonical = {
            ref["ifcGlobalId"]: ref["id"]
            for ref in twin["building"]["refs"]
            if getattr(staged_ifc.by_guid(ref["ifcGlobalId"]), "Representation", None)
            is not None
        }
        export_ifc_web_scene(
            staging / "building.ifc",
            staging / "building.glb",
            staging / "scene.manifest.json",
            canonical_by_global_id=canonical,
        )
        entries["building.ifc"] = (staging / "building.ifc").read_bytes()
        entries["building.glb"] = (staging / "building.glb").read_bytes()
        entries["scene.manifest.json"] = (staging / "scene.manifest.json").read_bytes()
        entries["twin.json"] = _json(twin)
        manifest["building"]["sha256"] = _digest(entries["building.ifc"])
        manifest["twin"]["sha256"] = _digest(entries["twin.json"])
        for derived in manifest["derived"]:
            derived["sha256"] = _digest(entries[derived["path"]])
        entries["project.json"] = _json(manifest)
        archive_path = staging / "edited.teldra"
        with ZipFile(archive_path, "w", compression=ZIP_STORED) as archive:
            for filename, data in sorted(entries.items()):
                archive.writestr(filename, data)
        # File opened exclusively only after every edit and GLB validation succeeds.
        with destination.open("xb") as output:
            output.write(archive_path.read_bytes())
    return changed_guid
