"""Convert SH3D semantics to a portable Studio project; never deserialize Java."""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile

from teldra_import_sh3d import import_home_to_ifc
from teldra_sh3d import load_sh3d
from teldra_web_export import export_ifc_web_scene
from teldra_web_export.wavefront import export_wavefront_scene


def convert(
    source: Path, destination: Path, *, visual_export: Path | None = None
) -> dict:
    if destination.exists():
        raise FileExistsError(f"Refusing to overwrite {destination}.")
    home = load_sh3d(source)
    imported = import_home_to_ifc(home)
    canonical = {
        global_id: f"sh3d:{source_key}"
        for source_key, global_id in imported.source_to_global_id.items()
    }
    kinds = {
        "IfcBuildingStorey": "storey",
        "IfcSpace": "space",
        "IfcWall": "wall",
        "IfcFurniture": "furniture",
        "IfcLightFixture": "fixture",
    }
    refs = []
    renderable = {}
    for global_id, canonical_id in canonical.items():
        entity = imported.model.by_guid(global_id)
        refs.append(
            {
                "id": canonical_id,
                "ifcGlobalId": global_id,
                "kind": kinds.get(entity.is_a(), "other"),
                "name": entity.Name or canonical_id,
            }
        )
        if getattr(entity, "Representation", None) is not None:
            renderable[global_id] = canonical_id
    if not renderable:
        raise ValueError("No supported renderable IFC geometry was imported.")

    report = {
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "counts": {
            key: len(getattr(home, key))
            for key in (
                "levels",
                "walls",
                "rooms",
                "furniture",
                "cameras",
            )
        },
        "mappedSourceIdentities": len(canonical),
        "renderableSourceIdentities": len(renderable),
        "warnings": list(imported.warnings)
        + [
            "Furniture models/textures and SH3D appearance are not converted to PBR assets.",
            "Rooms and furniture may retain IFC semantics without rendered body geometry.",
            "Cameras are source presentation data; Studio uses its own view.",
        ],
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Finish conversion before creating the destination; never overwrite user data.
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        staging = Path(temporary)
        imported.model.write(str(staging / "building.ifc"))
        if visual_export is None:
            export_ifc_web_scene(
                staging / "building.ifc",
                staging / "building.glb",
                staging / "scene.manifest.json",
                canonical_by_global_id=renderable,
            )
        else:
            receipt = json.loads((visual_export / "visual-export.json").read_text())
            if receipt.get("sourceSha256") != report["sourceSha256"] or not receipt.get(
                "xmlOnly"
            ):
                raise ValueError(
                    "Visual export does not match this XML-only SH3D source."
                )
            for item in receipt["files"]:
                path = (visual_export / item["path"]).resolve()
                if not path.is_relative_to(visual_export.resolve()):
                    raise ValueError("Visual export resource escapes its directory.")
                if hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
                    raise ValueError(f"Visual export checksum mismatch: {item['path']}")
            obj = (visual_export / receipt["obj"]).resolve()
            if not obj.is_relative_to(visual_export.resolve()):
                raise ValueError("Visual export OBJ escapes its directory.")
            report["visualScene"] = export_wavefront_scene(
                obj,
                staging / "building.glb",
                staging / "scene.manifest.json",
                building_sha256=hashlib.sha256(
                    (staging / "building.ifc").read_bytes()
                ).hexdigest(),
                source_bindings={
                    source_key: (canonical[global_id], global_id)
                    for source_key, global_id in imported.source_to_global_id.items()
                },
            )
            visual_keys = set(report["visualScene"]["sourceKeysWithVisuals"])
            non_rendering = []
            for piece in home.furniture:
                if piece.source.key in visual_keys:
                    continue
                if piece.materials and all(
                    material.color == 0 for material in piece.materials
                ):
                    non_rendering.append(
                        {
                            "sourceKey": piece.source.key,
                            "reason": "Fully transparent source material overrides",
                        }
                    )
                else:
                    raise ValueError(
                        f"Visual producer omitted furniture: {piece.source.key}"
                    )
            report["visualScene"]["nonRenderingFurniture"] = non_rendering
            report["warnings"] = list(imported.warnings) + [
                "The native visual scene is derived presentation geometry, not IFC architectural truth.",
                "Source Phong parameters are retained; ICC-tagged textures are color-managed to sRGB.",
                "Original images remain in source.sh3d; lighting is runtime-specific.",
            ]
            report["visualProducer"] = receipt
            # Keep every original source record and embedded asset recoverable.
            (staging / "source.sh3d").write_bytes(source.read_bytes())
        twin = {
            "schemaVersion": "0.1.0",
            "building": {
                "ifcSchema": "IFC4",
                "refs": refs,
            },
            "devices": [],
            "bindings": [],
        }
        (staging / "twin.json").write_bytes(_json(twin))
        (staging / "import-report.json").write_bytes(_json(report))

        def artifact(name: str) -> dict:
            return {
                "path": name,
                "sha256": hashlib.sha256((staging / name).read_bytes()).hexdigest(),
            }

        manifest = {
            "formatVersion": "0.1.0",
            "building": artifact("building.ifc"),
            "twin": artifact("twin.json"),
            "derived": [
                artifact(name)
                for name in (
                    "scene.manifest.json",
                    "building.glb",
                    "import-report.json",
                )
            ],
        }
        if visual_export is not None:
            manifest["derived"].append(artifact("source.sh3d"))
        (staging / "project.json").write_bytes(_json(manifest))
        package = staging / "imported.teldra"
        with ZipFile(package, "w", compression=ZIP_STORED) as archive:
            for path in sorted(staging.iterdir()):
                if path != package:
                    archive.write(path, path.name)
        with destination.open("xb") as output:
            output.write(package.read_bytes())
    return report


def _json(value: dict) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--visual-export",
        type=Path,
        help="Source-bound native export directory with visual-export.json",
    )
    mode.add_argument(
        "--architecture-only",
        action="store_true",
        help="Explicitly create the limited wall-only architectural scene",
    )
    args = parser.parse_args()
    print(
        json.dumps(
            convert(args.source, args.destination, visual_export=args.visual_export),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
