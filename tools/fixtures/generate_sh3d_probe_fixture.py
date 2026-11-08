"""Generate an asymmetric authored floor for GPU probe correspondence tests."""

import base64
import json
import tempfile
from pathlib import Path

from PIL import Image
from teldra_web_export.wavefront import export_wavefront_scene

ROOT = Path(__file__).resolve().parents[2]


def build():
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        image = Image.new("RGB", (16, 16))
        for y in range(16):
            for x in range(16):
                image.putpixel(
                    (x, y),
                    [(192, 32, 48), (24, 160, 40), (32, 48, 192), (224, 192, 16)][
                        (y // 8) * 2 + x // 8
                    ],
                )
        image.save(root / "dark.png")
        (root / "scene.mtl").write_text(
            "newmtl dark\nKa 0.2 0.2 0.2\nKd 1 1 1\nKs 0 0 0\nNs 1\nd 1\nmap_Kd dark.png\n"
        )
        (root / "scene.obj").write_text("""mtllib scene.mtl
v -100 0 -100
v -100 0 100
v 100 0 100
v 100 0 -100
vt 0 0
vt 0 1
vt 1 1
vt 1 0
vn 0 1 0
usemtl dark
g teldraVisible_room_probe_CullNone_1
f 1/1/1 2/2/1 3/3/1 4/4/1
""")
        export_wavefront_scene(
            root / "scene.obj",
            root / "scene.glb",
            root / "scene.json",
            building_sha256="a" * 64,
            source_bindings={
                "room:room-probe": ("sh3d:room:room-probe", "0123456789012345678901")
            },
            preview_lighting={
                "profile": "sh3d-preview-v1",
                "lightColor": 0xFFFFFF,
                "skyColor": 0xFFFFFF,
            },
        )
        return {
            "provenance": "Teldra-authored asymmetric red/green/blue/yellow floor; matte Phong",
            "manifest": json.loads((root / "scene.json").read_text()),
            "glbBase64": base64.b64encode((root / "scene.glb").read_bytes()).decode(),
        }


if __name__ == "__main__":
    destination = ROOT / "fixtures/sh3d/gpu-probe/fixture.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(build(), indent=2) + "\n")
