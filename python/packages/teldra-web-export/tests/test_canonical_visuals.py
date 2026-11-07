import json
import struct
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
import pytest
from teldra_web_export.canonical_visuals import attach_furniture_geometry


def test_native_triangles_become_local_ifc_geometry_without_changing_placement(tmp_path):
    root = Path(__file__).parents[4]
    model = ifcopenshell.open(str(root / "fixtures/projects/golden-home/building.ifc"))
    guid = "16W6mYG0DO8hR8U$bz6FSv"
    placement_id = model.by_guid(guid).ObjectPlacement.id()
    doc = {
        "nodes": [{"mesh": 0, "extras": {"teldra": {"ifcGlobalId": guid}}}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3},
            {"bufferView": 1, "componentType": 5125, "count": 3},
        ],
        "bufferViews": [{"byteOffset": 0}, {"byteOffset": 36}],
    }
    encoded = json.dumps(doc).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary = struct.pack("<9f3I", 1, 0, 1, 2, 0, 1, 1, 1, 1, 0, 1, 2)
    body = struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    body += struct.pack("<II", len(binary), 0x004E4942) + binary
    path = tmp_path / "source.glb"
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, len(body) + 12) + body)
    assert attach_furniture_geometry(model, path) == {"representedElements": 1, "triangles": 1}
    chair = model.by_guid(guid)
    assert chair.ObjectPlacement.id() == placement_id
    coordinates = (
        chair.Representation.Representations[0]
        .Items[0]
        .MappingSource.MappedRepresentation.Items[0]
        .Coordinates.CoordList
    )
    assert coordinates[0] == pytest.approx([0, 0, 0])
    assert coordinates[1] == pytest.approx([1, 0, 0])
    assert coordinates[2] == pytest.approx([0, 0, 1])
    settings = ifcopenshell.geom.settings()
    shape = ifcopenshell.geom.create_shape(settings, chair)
    assert len(shape.geometry.faces) == 3
