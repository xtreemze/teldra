"""Optional external Sweet Home 3D producer; no vendor binaries are bundled."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from zipfile import ZIP_STORED, ZipFile

from teldra_sh3d import parse_home_xml


def xml_only_archive(source: Path, destination: Path) -> None:
    with (
        ZipFile(source) as archive,
        ZipFile(destination, "w", compression=ZIP_STORED) as output,
    ):
        entries = archive.infolist()
        if (
            len(entries) > 10_000
            or sum(item.file_size for item in entries) > 2 * 1024**3
        ):
            raise ValueError("SH3D archive exceeds the visual producer limits.")
        names = [item.filename for item in entries]
        if len(names) != len(set(names)) or names.count("Home.xml") != 1:
            raise ValueError("SH3D must have unique entries and exactly one Home.xml.")
        for item in entries:
            name = PurePosixPath(item.filename)
            if (
                name.is_absolute()
                or ".." in name.parts
                or ":" in item.filename
                or "\\" in item.orig_filename
                or item.flag_bits & 1
                or item.file_size > 512 * 1024**2
                or item.file_size / max(item.compress_size, 1) > 200
                or (item.external_attr >> 16) & 0o170000 == 0o120000
            ):
                raise ValueError(f"Unsafe SH3D resource: {item.filename}")
        if archive.getinfo("Home.xml").file_size > 16 * 1024**2:
            raise ValueError("Home.xml exceeds the XML limit.")
        xml = archive.read("Home.xml")
        parse_home_xml(xml)  # Enforces the XML/DTD/entity boundary before native code.
        from xml.etree import ElementTree

        root = ElementTree.fromstring(xml)
        for node in root.iter():
            if (
                node.tag == "property"
                and node.get("type") == "CONTENT"
                and node.get("value") not in names
            ):
                raise ValueError("Non-embedded SH3D content property.")
            for key in ("model", "image", "icon", "planIcon"):
                reference = node.get(key)
                if reference is not None and reference not in names:
                    raise ValueError(f"Non-embedded SH3D resource: {reference}")
        for item in entries:
            if item.filename == "Home" or item.is_dir():
                continue
            with (
                archive.open(item) as incoming,
                output.open(item.filename, "w") as outgoing,
            ):
                shutil.copyfileobj(incoming, outgoing)


def export(
    source: Path,
    destination: Path,
    installation: Path,
    java: Path,
    compiler_jar: Path | None = None,
    javac: str = "javac",
) -> dict:
    if destination.exists():
        raise FileExistsError(f"Visual export directory already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        staging = Path(temporary).resolve()
        xml_archive = staging / "xml-only.sh3d"
        xml_only_archive(source, xml_archive)
        libraries = installation / "lib"
        classpath = os.pathsep.join(
            str(path.resolve()) for path in libraries.glob("*.jar")
        )
        wrapper = Path(__file__).with_name("ExportHome.java").resolve()
        # Compile against public APIs only. Vendor implementation code is not copied.
        if compiler_jar is None:
            compile_command = [javac, "-source", "8", "-target", "8"]
        else:
            compile_command = [str(java), "-jar", str(compiler_jar.resolve()), "-1.8"]
        subprocess.run(
            [*compile_command, "-cp", classpath, "-d", str(staging), str(wrapper)],
            check=True,
            timeout=120,
            capture_output=True,
        )
        native_dir = staging / "visuals"
        native_dir.mkdir()
        obj = native_dir / "scene.obj"
        run = subprocess.run(
            [
                str(java),
                "-Xmx1200m",
                f"-Djava.library.path={libraries.resolve()}",
                "-cp",
                str(staging) + os.pathsep + classpath,
                "ExportHome",
                str(xml_archive),
                str(obj),
            ],
            check=True,
            timeout=300,
            capture_output=True,
            text=True,
        )
        receipt = {
            "producer": "installed-sweethome3d-public-api",
            "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "vendorJarSha256": hashlib.sha256(
                (libraries / "SweetHome3D.jar").read_bytes()
            ).hexdigest(),
            "xmlOnly": True,
            "summary": run.stdout.strip(),
            "obj": obj.name,
            "files": [
                {
                    "path": path.name,
                    "bytes": path.stat().st_size,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                }
                for path in sorted(native_dir.iterdir())
            ],
        }
        (native_dir / "visual-export.json").write_text(
            json.dumps(receipt, indent=2) + "\n"
        )
        # The completed producer directory becomes visible only after successful export.
        shutil.copytree(native_dir, destination)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--installation", required=True, type=Path)
    parser.add_argument(
        "--java",
        required=True,
        type=Path,
        help="Java runtime matching the installation's native-library architecture",
    )
    parser.add_argument(
        "--compiler-jar", type=Path, help="Optional local Eclipse ECJ compiler JAR"
    )
    parser.add_argument("--javac", default="javac")
    args = parser.parse_args()
    receipt = export(
        args.source.resolve(),
        args.destination.resolve(),
        args.installation.resolve(),
        args.java.resolve(),
        args.compiler_jar,
        args.javac,
    )
    print(receipt["summary"])


if __name__ == "__main__":
    main()
