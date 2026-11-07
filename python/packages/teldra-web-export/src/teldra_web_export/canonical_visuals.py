"""Bind our source-tagged native mesh export to canonical IFC furniture geometry."""

import json
import struct
from pathlib import Path

import ifcopenshell.util.placement
import numpy as np


def attach_furniture_geometry(model, glb_path: Path) -> dict:
    payload = glb_path.read_bytes()
    json_size = struct.unpack_from("<I", payload, 12)[0]
    doc = json.loads(payload[20 : 20 + json_size])
    binary = payload[28 + json_size :]
    grouped = {}
    context = next(
        item
        for item in model.by_type("IfcGeometricRepresentationSubContext")
        if item.ContextIdentifier == "Body"
    )

    def read(index, width):
        accessor = doc["accessors"][index]
        view = doc["bufferViews"][accessor["bufferView"]]
        dtype = {5126: "<f4", 5125: "<u4", 5123: "<u2"}[accessor["componentType"]]
        if view.get("byteStride") or accessor.get("sparse"):
            raise ValueError("Canonical visual import requires our packed native export.")
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        return np.frombuffer(
            binary, dtype=dtype, count=accessor["count"] * width, offset=offset
        ).reshape((-1, width))

    for node in doc["nodes"]:
        identity = node.get("extras", {}).get("teldra", {})
        guid = identity.get("ifcGlobalId")
        if not guid:
            continue
        entity = model.by_guid(guid)
        if entity.is_a() not in {"IfcFurniture", "IfcLightFixture", "IfcBuildingElementProxy"}:
            continue
        if entity.Representation is not None:
            continue
        if any(key in node for key in ("matrix", "translation", "rotation", "scale", "children")):
            raise ValueError("Canonical visual import requires flattened source geometry.")
        vertices, faces = grouped.setdefault(guid, ([], []))
        inverse = np.linalg.inv(
            ifcopenshell.util.placement.get_local_placement(entity.ObjectPlacement)
        )
        for primitive in doc["meshes"][node["mesh"]]["primitives"]:
            if primitive.get("mode", 4) != 4:
                continue
            scene = read(primitive["attributes"]["POSITION"], 3).astype(float)
            canonical = np.column_stack(
                (scene[:, 0], -scene[:, 2], scene[:, 1], np.ones(len(scene)))
            )
            local = (canonical @ inverse.T)[:, :3]
            indices = read(primitive["indices"], 1).reshape((-1, 3))
            offset = len(vertices) + 1
            vertices.extend(local.tolist())
            faces.extend((indices + offset).tolist())

    triangles = 0
    for guid, (vertices, faces) in grouped.items():
        if not faces:
            continue
        coordinates = model.create_entity("IfcCartesianPointList3D", CoordList=vertices)
        mesh = model.create_entity(
            "IfcTriangulatedFaceSet", Coordinates=coordinates, CoordIndex=faces, Closed=None
        )
        shape = model.create_entity(
            "IfcShapeRepresentation",
            ContextOfItems=context,
            RepresentationIdentifier="Body",
            RepresentationType="Tessellation",
            Items=[mesh],
        )
        model.by_guid(guid).Representation = model.create_entity(
            "IfcProductDefinitionShape", Representations=[shape]
        )
        triangles += len(faces)
    return {
        "representedElements": sum(bool(faces) for _, faces in grouped.values()),
        "triangles": triangles,
    }
