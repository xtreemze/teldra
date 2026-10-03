from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import tempfile
import uuid
from pathlib import Path

import ifcopenshell.guid
from teldra_ifc import resolve_global_id, write_model
from teldra_import_sh3d import import_home_to_ifc
from teldra_sh3d import parse_home_xml

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SOURCE_XML = REPOSITORY_ROOT / "fixtures" / "sh3d" / "golden-home" / "Home.xml"
PROJECT_DIR = REPOSITORY_ROOT / "fixtures" / "projects" / "golden-home"
IFC_DESTINATION = PROJECT_DIR / "building.ifc"
IDENTITY_DESTINATION = PROJECT_DIR / "identity-map.json"
PROJECT_DESTINATION = PROJECT_DIR / "project.json"
TWIN_PATH = PROJECT_DIR / "twin.json"

_NAMESPACE = uuid.UUID("0fa95fe1-2293-44d4-b48b-37e95565ea37")

CANONICAL_BY_SOURCE = {
    "level:level0": "storey:ground-floor",
    "wall:wall0": "wall:golden-home:wall0",
    "wall:wall1": "wall:golden-home:wall1",
    "wall:wall2": "wall:golden-home:wall2",
    "wall:wall3": "wall:golden-home:wall3",
    "room:room0": "space:living-room",
    "pieceOfFurniture:chair0": "furniture:golden-home:chair0",
    "doorOrWindow:door0": "opening:golden-home:door0",
    "light:light0": "fixture:living-room-floor-lamp",
}

# These identities already form part of the checked-in twin/scene fixture contract.
EXPLICIT_GLOBAL_IDS = {
    "room:room0": "3ZYNKvi3P3FvKPBGP9UP7n",
    "light:light0": "0ufYQjmwP0Ah$QRRxVbqR3",
}


def deterministic_ifc_guid(seed: str) -> str:
    return ifcopenshell.guid.compress(uuid.uuid5(_NAMESPACE, seed).hex)


def build_fixture() -> tuple[bytes, bytes, bytes]:
    home = parse_home_xml(SOURCE_XML.read_bytes())
    imported = import_home_to_ifc(home)
    model = imported.model

    original_source_by_global_id = {
        global_id: source_key
        for source_key, global_id in imported.source_to_global_id.items()
    }

    source_global_ids: dict[str, str] = {}

    for ordinal, entity in enumerate(model.by_type("IfcRoot")):
        previous_global_id = entity.GlobalId
        source_key = original_source_by_global_id.get(previous_global_id)

        if source_key is not None:
            global_id = EXPLICIT_GLOBAL_IDS.get(
                source_key,
                deterministic_ifc_guid(f"source:{source_key}"),
            )
            source_global_ids[source_key] = global_id
        else:
            name = getattr(entity, "Name", None) or ""
            global_id = deterministic_ifc_guid(
                f"root:{ordinal}:{entity.is_a()}:{name}",
            )

        entity.GlobalId = global_id

    missing = sorted(set(CANONICAL_BY_SOURCE) - set(source_global_ids))
    if missing:
        raise RuntimeError(
            "Golden IFC generation did not materialize expected source identities: "
            + ", ".join(missing)
        )

    with tempfile.TemporaryDirectory() as directory:
        temporary = Path(directory) / "golden-home.ifc"
        write_model(model, temporary)
        text = temporary.read_text(encoding="utf-8")

    # IfcOpenShell writes host path/time into FILE_NAME. Normalize both so fixture
    # bytes are stable across machines while preserving the actual IFC content.
    text = re.sub(
        r"FILE_NAME\('[^']*','[^']*'",
        "FILE_NAME('golden-home.ifc','2026-10-03T00:00:00'",
        text,
        count=1,
    )
    ifc_bytes = text.replace("\r\n", "\n").encode("utf-8")

    identity_document = {
        "schemaVersion": "0.1.0",
        "source": "fixtures/sh3d/golden-home/Home.xml",
        "ifc": "building.ifc",
        "entries": [
            {
                "sourceKey": source_key,
                "canonicalId": CANONICAL_BY_SOURCE[source_key],
                "ifcGlobalId": source_global_ids[source_key],
            }
            for source_key in sorted(CANONICAL_BY_SOURCE)
        ],
    }
    identity_bytes = (
        json.dumps(identity_document, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")

    project_document = {
        "formatVersion": "0.1.0",
        "building": {
            "path": "building.ifc",
            "sha256": hashlib.sha256(ifc_bytes).hexdigest(),
        },
        "twin": {
            "path": "twin.json",
            "sha256": hashlib.sha256(TWIN_PATH.read_bytes()).hexdigest(),
        },
        "derived": [
            {
                "path": "scene.manifest.json",
                "sha256": hashlib.sha256(
                    (PROJECT_DIR / "scene.manifest.json").read_bytes()
                ).hexdigest(),
            },
            {
                "path": "appearance.manifest.json",
                "sha256": hashlib.sha256(
                    (PROJECT_DIR / "appearance.manifest.json").read_bytes()
                ).hexdigest(),
            },
            {
                "path": "lighting.manifest.json",
                "sha256": hashlib.sha256(
                    (PROJECT_DIR / "lighting.manifest.json").read_bytes()
                ).hexdigest(),
            },
        ],
    }
    project_bytes = (
        json.dumps(project_document, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")

    return ifc_bytes, identity_bytes, project_bytes


def emit_payload(name: str, payload: bytes) -> None:
    encoded = base64.b64encode(payload).decode("ascii")
    print(f"TELDRA_FIXTURE_BEGIN:{name}")
    print(encoded)
    print(f"TELDRA_FIXTURE_END:{name}")


def write_fixture() -> None:
    ifc_bytes, identity_bytes, project_bytes = build_fixture()
    IFC_DESTINATION.write_bytes(ifc_bytes)
    IDENTITY_DESTINATION.write_bytes(identity_bytes)
    PROJECT_DESTINATION.write_bytes(project_bytes)


def check_fixture() -> None:
    expected = {
        IFC_DESTINATION: build_fixture()[0],
        IDENTITY_DESTINATION: build_fixture()[1],
        PROJECT_DESTINATION: build_fixture()[2],
    }
    stale = [
        path.relative_to(REPOSITORY_ROOT).as_posix()
        for path, generated in expected.items()
        if not path.is_file() or path.read_bytes() != generated
    ]
    if stale:
        raise SystemExit(
            "Golden fixture corpus is stale; run "
            "'cd python && uv run python ../tools/fixtures/generate_golden_home.py --write': "
            + ", ".join(stale)
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--emit-base64", action="store_true")
    args = parser.parse_args()

    if sum((args.write, args.check, args.emit_base64)) != 1:
        parser.error("choose exactly one of --write, --check, --emit-base64")

    if args.write:
        write_fixture()
        return

    if args.check:
        check_fixture()
        return

    ifc_bytes, identity_bytes, project_bytes = build_fixture()
    emit_payload("building.ifc", ifc_bytes)
    emit_payload("identity-map.json", identity_bytes)
    emit_payload("project.json", project_bytes)


if __name__ == "__main__":
    main()
