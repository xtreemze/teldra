"""Offline .teldra source-IFC/GLB derivative rebake; never overwrites input.

Usage (from the Teldra Python workspace):
    uv run python ../tools/import/rebake_static_scene.py edited.teldra rebuilt.teldra

An existing IFC edit and hash-bound placement reconciliation are required.
This does *not* create or modify an IFC scale command, and is not a generic
GLB conversion tool. Only static flattened SH3D triangle render parts qualify.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from teldra_web_export import rebake_static_teldra_archive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Existing, hash-verified edited .teldra")
    parser.add_argument("destination", type=Path, help="New .teldra; must not exist")
    args = parser.parse_args()
    if args.source.resolve() == args.destination.resolve():
        parser.error("Source and destination must be different.")
    result = rebake_static_teldra_archive(args.source.read_bytes())
    # 'xb' refuses to overwrite user files even if they appear during validation.
    with args.destination.open("xb") as output:
        output.write(result.archive)
    print(
        json.dumps(
            {
                "destination": str(args.destination),
                "sourceSceneSha256": result.source_scene_sha256,
                "canonicalBuildingSha256": result.current_ifc_sha256,
                "rebakedSceneSha256": result.baked.baked_sha256,
                "canonicalIds": result.baked.canonical_ids,
                "triangles": result.baked.triangles,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
