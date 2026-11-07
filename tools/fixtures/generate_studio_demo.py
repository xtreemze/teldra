"""Build the small Teldra-authored public Studio demo; no real-home data."""

from __future__ import annotations

import hashlib
import json
import struct
import tempfile
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile, ZipInfo

import ifcopenshell
from teldra_web_export import export_ifc_web_scene

ROOT = Path(__file__).resolve().parents[2]
DESTINATION = ROOT / "apps/studio/public/demo.teldra"


def build(destination: Path) -> None:
    model = ifcopenshell.open(str(ROOT / "fixtures/projects/golden-home/building.ifc"))
    context = next(
        item
        for item in model.by_type("IfcGeometricRepresentationSubContext")
        if item.ContextIdentifier == "Body"
    )

    def box(x, y, z, width, depth, height):
        profile = model.create_entity(
            "IfcRectangleProfileDef", ProfileType="AREA", XDim=width, YDim=depth
        )
        placement = model.create_entity(
            "IfcAxis2Placement3D",
            Location=model.create_entity(
                "IfcCartesianPoint", Coordinates=(float(x), float(y), float(z))
            ),
        )
        return model.create_entity(
            "IfcExtrudedAreaSolid",
            SweptArea=profile,
            Position=placement,
            ExtrudedDirection=model.create_entity(
                "IfcDirection", DirectionRatios=(0.0, 0.0, 1.0)
            ),
            Depth=height,
        )

    def shape(entity, items):
        rep = model.create_entity(
            "IfcShapeRepresentation",
            ContextOfItems=context,
            RepresentationIdentifier="Body",
            RepresentationType="SweptSolid",
            Items=items,
        )
        entity.Representation = model.create_entity(
            "IfcProductDefinitionShape", Representations=[rep]
        )

    identities = json.loads(
        (ROOT / "fixtures/projects/golden-home/identity-map.json").read_text()
    )["entries"]
    mappings = {item["ifcGlobalId"]: item["canonicalId"] for item in identities}
    chair = model.by_guid("16W6mYG0DO8hR8U$bz6FSv")
    shape(
        chair,
        [
            box(0, 0, 0.42, 0.55, 0.55, 0.1),
            box(0, 0.23, 0.5, 0.55, 0.08, 0.5),
            *[
                box(x, y, 0, 0.06, 0.06, 0.42)
                for x in (-0.21, 0.21)
                for y in (-0.21, 0.21)
            ],
        ],
    )
    lamp = model.by_guid("0ufYQjmwP0Ah$QRRxVbqR3")
    shape(
        lamp,
        [
            box(0, 0, 0, 0.32, 0.32, 0.04),
            box(0, 0, 0.04, 0.04, 0.04, 1.25),
            box(0, 0, 1.29, 0.45, 0.45, 0.3),
        ],
    )
    floor = model.create_entity(
        "IfcSlab",
        GlobalId="0123456789012345678903",
        Name="Timber floor",
        PredefinedType="FLOOR",
    )
    shape(floor, [box(2.5, -2.0, -0.08, 5.0, 4.0, 0.08)])
    mappings[floor.GlobalId] = "slab:demo:floor"
    # Only objects with visual bodies belong to the derived render manifest.
    mappings = {
        guid: key
        for guid, key in mappings.items()
        if model.by_guid(guid).Representation is not None
    }
    with tempfile.TemporaryDirectory() as directory:
        stage = Path(directory)
        model.header.file_name.time_stamp = "2026-01-01T00:00:00"
        model.write(str(stage / "building.ifc"))
        export_ifc_web_scene(
            stage / "building.ifc",
            stage / "building.glb",
            stage / "scene.manifest.json",
            canonical_by_global_id=mappings,
        )
        payload = (stage / "building.glb").read_bytes()
        json_size = struct.unpack_from("<I", payload, 12)[0]
        doc = json.loads(payload[20 : 20 + json_size])
        palette = {
            "furniture": [0.13, 0.36, 0.34, 1.0],
            "fixture": [0.89, 0.66, 0.31, 1.0],
            "slab": [0.58, 0.39, 0.23, 1.0],
            "wall": [0.81, 0.83, 0.80, 1.0],
        }
        for node in doc["nodes"]:
            identity = node.get("extras", {}).get("teldra", {})
            if not identity:
                continue
            prefix = identity["canonicalId"].split(":")[0]
            material = {
                "name": prefix,
                "pbrMetallicRoughness": {
                    "baseColorFactor": palette.get(prefix, [0.6, 0.6, 0.6, 1.0]),
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.7,
                },
                "doubleSided": False,
            }
            doc.setdefault("materials", []).append(material)
            for primitive in doc["meshes"][node["mesh"]]["primitives"]:
                primitive["material"] = len(doc["materials"]) - 1
            if identity["canonicalId"].endswith(("wall0", "wall1")):
                node["extras"]["teldraSourceVisibility"] = {"hidden": True}
            node["extras"]["teldraSourceLayer"] = {
                "levelId": "demo-ground",
                "levelName": "Ground floor",
            }
        js = json.dumps(doc, separators=(",", ":")).encode()
        js += b" " * (-len(js) % 4)
        rest = payload[20 + json_size :]
        (stage / "building.glb").write_bytes(
            struct.pack("<4sII", b"glTF", 2, 20 + len(js) + len(rest))
            + struct.pack("<II", len(js), 0x4E4F534A)
            + js
            + rest
        )
        manifest = json.loads((stage / "scene.manifest.json").read_text())
        manifest["scene"]["assetSha256"] = hashlib.sha256(
            (stage / "building.glb").read_bytes()
        ).hexdigest()
        (stage / "scene.manifest.json").write_text(json.dumps(manifest, sort_keys=True))
        twin = json.loads(
            (ROOT / "fixtures/projects/golden-home/twin.json").read_text()
        )
        twin["bindings"] = []
        twin["building"]["refs"] = [
            {
                "id": key,
                "ifcGlobalId": guid,
                "name": model.by_guid(guid).Name or key,
                "kind": "furniture"
                if key.startswith("furniture")
                else "wall"
                if key.startswith("wall")
                else "fixture"
                if key.startswith("fixture")
                else "other",
            }
            for guid, key in mappings.items()
        ]
        twin["devices"][0]["placement"] = {
            "frame": "ifc-world-metres-z-up",
            "position": [2.0, -1.5, 0.0],
            "rotationQuaternion": [0.0, 0.0, 0.0, 1.0],
        }
        # The placement schema is supplied by the canonical spatial-editing slice.
        (stage / "twin.json").write_text(json.dumps(twin, sort_keys=True))

        def artifact(name):
            return {
                "path": name,
                "sha256": hashlib.sha256((stage / name).read_bytes()).hexdigest(),
            }

        project = {
            "formatVersion": "0.1.0",
            "building": artifact("building.ifc"),
            "twin": artifact("twin.json"),
            "derived": [artifact("building.glb"), artifact("scene.manifest.json")],
        }
        (stage / "project.json").write_text(json.dumps(project, sort_keys=True))
        destination.parent.mkdir(parents=True, exist_ok=True)
        with ZipFile(destination, "w", compression=ZIP_STORED) as archive:
            for path in sorted(stage.iterdir()):
                entry = ZipInfo(path.name, date_time=(2026, 1, 1, 0, 0, 0))
                entry.compress_type = ZIP_STORED
                archive.writestr(entry, path.read_bytes())
    print(f"Public synthetic demo: {destination.stat().st_size} bytes")


if __name__ == "__main__":
    build(DESTINATION)
