from __future__ import annotations

import runpy
from pathlib import Path
from zipfile import ZipFile

import pytest

ROOT = Path(__file__).parents[4]
xml_only_archive = runpy.run_path(str(ROOT / "integrations/sweethome3d/export_visuals.py"))[
    "xml_only_archive"
]


def test_native_producer_never_receives_the_java_serialization_entry(tmp_path) -> None:
    source = tmp_path / "source.sh3d"
    with ZipFile(source, "w") as archive:
        archive.writestr("Home", b"untrusted serialized bytes")
        archive.writestr("Home.xml", "<home/>")
        archive.writestr("model.obj", "v 0 0 0")
    destination = tmp_path / "xml-only.sh3d"
    xml_only_archive(source, destination)
    with ZipFile(destination) as archive:
        assert "Home" not in archive.namelist()
        assert archive.read("model.obj") == b"v 0 0 0"


@pytest.mark.parametrize("name", ["../escape", "/absolute", "C:/private", "a\\b"])
def test_native_producer_rejects_unsafe_archive_names(tmp_path, name) -> None:
    source = tmp_path / "source.sh3d"
    with ZipFile(source, "w") as archive:
        archive.writestr("Home.xml", "<home/>")
        archive.writestr(name, "data")
    if name == "a\\b":
        # ZipInfo normalizes Windows separators during creation; construct the
        # actual hostile filename in both same-length ZIP name records.
        source.write_bytes(source.read_bytes().replace(b"a/b", b"a\\b"))
    with pytest.raises(ValueError, match="Unsafe"):
        xml_only_archive(source, tmp_path / "out.sh3d")


def test_native_producer_rejects_external_asset_references(tmp_path) -> None:
    source = tmp_path / "source.sh3d"
    with ZipFile(source, "w") as archive:
        archive.writestr(
            "Home.xml",
            """<home><pieceOfFurniture name='remote' x='0' y='0'
          width='1' depth='1' height='1' model='https://host/model.obj'/></home>""",
        )
    with pytest.raises(ValueError, match="Non-embedded"):
        xml_only_archive(source, tmp_path / "out.sh3d")
