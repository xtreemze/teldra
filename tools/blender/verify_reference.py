from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path
from typing import Any


JSON_CHUNK = 0x4E4F534A
EXPECTED_NODE_KEY = "reference:blender-cube:body"
EXPECTED_CANONICAL_ID = "fixture:blender-reference-cube"
EXPECTED_MATERIAL_KEY = "reference-blue-metallic-roughness"


def read_glb_json(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    if len(data) < 20:
        raise AssertionError("GLB is too small")

    magic, version, total_length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise AssertionError("invalid GLB magic")
    if version != 2:
        raise AssertionError(f"unsupported GLB version: {version}")
    if total_length != len(data):
        raise AssertionError("GLB declared length does not match file length")

    offset = 12
    while offset + 8 <= len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset : offset + chunk_length]
        offset += chunk_length

        if chunk_type == JSON_CHUNK:
            return json.loads(chunk.rstrip(b" \t\r\n\x00").decode("utf8"))

    raise AssertionError("GLB has no JSON chunk")


def verify_metadata(output_dir: Path, toolchain: dict[str, Any]) -> dict[str, Any]:
    metadata = json.loads(
        (output_dir / "reference.metadata.json").read_text(encoding="utf8")
    )

    expected_version = toolchain["blenderVersion"]
    if metadata["blenderVersion"] != expected_version:
        raise AssertionError(
            f"Blender version mismatch: {metadata['blenderVersion']} != {expected_version}"
        )
    if metadata["cyclesVersion"] != toolchain["cyclesVersion"]:
        raise AssertionError(
            f"Cycles version mismatch: {metadata['cyclesVersion']} != {toolchain['cyclesVersion']}"
        )
    if metadata["buildHash"] != toolchain["buildHash"]:
        raise AssertionError(
            f"Blender build hash mismatch: {metadata['buildHash']} != {toolchain['buildHash']}"
        )
    if metadata["nodeKey"] != EXPECTED_NODE_KEY:
        raise AssertionError("reference nodeKey changed")
    if metadata["canonicalId"] != EXPECTED_CANONICAL_ID:
        raise AssertionError("reference canonicalId changed")
    if metadata["materialKey"] != EXPECTED_MATERIAL_KEY:
        raise AssertionError("reference materialKey changed")

    metrics = metadata["metrics"]
    if metrics["engine"] != "CYCLES":
        raise AssertionError("reference render did not use Cycles")
    if metrics["device"] != "CPU":
        raise AssertionError("reference render must use CPU")
    if metrics["width"] != 64 or metrics["height"] != 64:
        raise AssertionError("reference render dimensions changed")
    if metrics["samples"] != 8:
        raise AssertionError("reference render sample count changed")

    mean = float(metrics["meanLuminance"])
    contrast = float(metrics["contrast"])
    certification = toolchain["certification"]["cycles"]
    expected_mean = float(certification["meanLuminance"])
    mean_tolerance = float(certification["meanTolerance"])
    expected_contrast = float(certification["contrast"])
    contrast_tolerance = float(certification["contrastTolerance"])

    if abs(mean - expected_mean) > mean_tolerance:
        raise AssertionError(
            f"Cycles mean luminance drifted: {mean} vs {expected_mean} "
            f"(tolerance {mean_tolerance})"
        )
    if abs(contrast - expected_contrast) > contrast_tolerance:
        raise AssertionError(
            f"Cycles contrast drifted: {contrast} vs {expected_contrast} "
            f"(tolerance {contrast_tolerance})"
        )

    render_path = output_dir / metrics["renderPath"]
    if not render_path.is_file() or render_path.stat().st_size == 0:
        raise AssertionError("Cycles reference render is missing")

    return metadata


def verify_glb(output_dir: Path, metadata: dict[str, Any]) -> None:
    document = read_glb_json(output_dir / metadata["glbPath"])

    materials = {
        item.get("name")
        for item in document.get("materials", [])
        if isinstance(item, dict)
    }
    if EXPECTED_MATERIAL_KEY not in materials:
        raise AssertionError("reference material did not survive Blender GLB export")

    matching_nodes = []
    for node in document.get("nodes", []):
        if not isinstance(node, dict):
            continue
        extras = node.get("extras")
        if not isinstance(extras, dict):
            continue
        teldra = extras.get("teldra")
        if not isinstance(teldra, dict):
            continue
        if teldra.get("nodeKey") == EXPECTED_NODE_KEY:
            matching_nodes.append((node, teldra))

    if len(matching_nodes) != 1:
        raise AssertionError(
            f"expected exactly one node carrying {EXPECTED_NODE_KEY}, "
            f"got {len(matching_nodes)}"
        )

    node, teldra = matching_nodes[0]
    if teldra.get("canonicalId") != EXPECTED_CANONICAL_ID:
        raise AssertionError("canonicalId did not survive Blender GLB export")
    if teldra.get("materialKey") != EXPECTED_MATERIAL_KEY:
        raise AssertionError("materialKey did not survive Blender GLB export")

    mesh_index = node.get("mesh")
    if not isinstance(mesh_index, int):
        raise AssertionError("reference identity node has no mesh")

    meshes = document.get("meshes", [])
    if mesh_index < 0 or mesh_index >= len(meshes):
        raise AssertionError("reference mesh index is out of range")

    primitives = meshes[mesh_index].get("primitives", [])
    if len(primitives) == 0:
        raise AssertionError("reference mesh has no primitives")

    attributes = primitives[0].get("attributes", {})
    if "TEXCOORD_0" not in attributes:
        raise AssertionError("reference GLB is missing UV0")
    if "TEXCOORD_1" not in attributes:
        raise AssertionError("reference GLB is missing UV1")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir")
    parser.add_argument(
        "--toolchain",
        default="integrations/blender/reference-toolchain.json",
    )
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    toolchain = json.loads(Path(args.toolchain).read_text(encoding="utf8"))

    if toolchain["status"] != "certified":
        raise AssertionError("reference toolchain must be certified")

    metadata = verify_metadata(output_dir, toolchain)
    verify_glb(output_dir, metadata)

    metrics = metadata["metrics"]
    print(
        "Blender reference producer OK: "
        + metadata["blenderVersion"]
        + ", mean luminance "
        + format(float(metrics["meanLuminance"]), ".6f")
        + ", contrast "
        + format(float(metrics["contrast"]), ".6f")
    )


if __name__ == "__main__":
    main()
