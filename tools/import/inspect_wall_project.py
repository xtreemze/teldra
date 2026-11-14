"""Read-only safety preflight for Teldra architecture-only wall authoring.

Example from the python workspace:
  uv run --locked python ../tools/import/inspect_wall_project.py home.teldra

Use the returned sourceSha256 and storeys[].ifcGlobalId when invoking
edit_wall_project.py with --expected-source-sha256 and --storey-guid.
A report is not authorization to edit native Sweet Home 3D visuals.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from edit_wall_project import inspect_wall_archive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Existing architecture-only .teldra")
    args = parser.parse_args()
    print(json.dumps(inspect_wall_archive(args.source), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
