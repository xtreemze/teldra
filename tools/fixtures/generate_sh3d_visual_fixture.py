"""Generate a tiny Teldra-authored textured/hidden-layer browser contract fixture."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import struct
import tempfile
import zlib
from pathlib import Path

from teldra_web_export.wavefront import export_wavefront_scene

ROOT = Path(__file__).resolve().parents[2]
DESTINATION = ROOT / "fixtures/sh3d/visual-transport/fixture.json"


def build() -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", binascii.crc32(kind + payload))
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 6, 0, 0, 0))
    png += chunk(
        b"IDAT",
        zlib.compress(
            bytes(
                [
                    0,
                    255,
                    0,
                    0,
                    255,
                    0,
                    255,
                    0,
                    255,
                    0,
                    0,
                    0,
                    255,
                    255,
                    255,
                    255,
                    255,
                    0,
                ]
            )
        ),
    )
    png += chunk(b"IEND", b"")
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        (root / "pattern.png").write_bytes(png)
        (root / "scene.mtl").write_text(
            "newmtl patterned\nKa 0.2 0.2 0.2\nKd 1 1 1\nKs 2 1 1\nNs 60\n"
            "d 0.7\nNi 1.5\nillum 2\nmap_Kd pattern.png\n"
        )
        (root / "scene.obj").write_text("""mtllib scene.mtl
v -100 -100 0
v 100 -100 0
v 0 100 0
v 0 0 100
vt 0 0
vt 1 0
vt 0.5 1
vn 0 0 1
usemtl patterned
g teldraVisible_furniture
f 1/1/1 2/2/1 3/3/1
g teldraHidden_ceiling
f 1/1/1 2/2/1 4/3/1
""")
        export_wavefront_scene(
            root / "scene.obj",
            root / "scene.glb",
            root / "scene.json",
            building_sha256="a" * 64,
        )
        result = {
            "provenance": "Teldra-authored synthetic geometry and 2x2 RGBA texture",
            "manifest": json.loads((root / "scene.json").read_text()),
            "glbBase64": base64.b64encode((root / "scene.glb").read_bytes()).decode(),
        }
        return (json.dumps(result, indent=2) + "\n").encode()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    payload = build()
    if args.check:
        if DESTINATION.read_bytes() != payload:
            raise SystemExit("SH3D visual fixture is stale.")
    else:
        DESTINATION.parent.mkdir(parents=True, exist_ok=True)
        DESTINATION.write_bytes(payload)


if __name__ == "__main__":
    main()
