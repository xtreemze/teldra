from __future__ import annotations

from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from .model import (
    Sh3dCamera,
    Sh3dFurniture,
    Sh3dHome,
    Sh3dLevel,
    Sh3dLightSource,
    Sh3dMaterial,
    Sh3dPoint,
    Sh3dRoom,
    Sh3dSourceRef,
    Sh3dWall,
    Sh3dWallBinding,
)

CENTIMETRES_TO_METRES = 0.01
MAX_HOME_XML_BYTES = 16 * 1024 * 1024


class Sh3dFormatError(ValueError):
    """Raised when a .sh3d archive or Home.xml cannot be imported safely."""


def load_sh3d(source: str | Path) -> Sh3dHome:
    """Read the documented Home.xml entry without Java object deserialization."""

    path = Path(source)
    try:
        with ZipFile(path) as archive:
            entries = [entry for entry in archive.infolist() if entry.filename == "Home.xml"]
            if len(entries) != 1:
                raise Sh3dFormatError(
                    f"{path.name} must contain exactly one Home.xml entry; found {len(entries)}."
                )

            entry = entries[0]
            if entry.flag_bits & 0x1:
                raise Sh3dFormatError("Encrypted Home.xml entries are not supported.")
            if entry.file_size > MAX_HOME_XML_BYTES:
                raise Sh3dFormatError(
                    f"Home.xml exceeds the {MAX_HOME_XML_BYTES}-byte safety limit."
                )

            with archive.open(entry) as stream:
                payload = stream.read(MAX_HOME_XML_BYTES + 1)
    except BadZipFile as error:
        raise Sh3dFormatError(f"{path.name} is not a valid SH3D ZIP archive.") from error

    if len(payload) > MAX_HOME_XML_BYTES:
        raise Sh3dFormatError(f"Home.xml exceeds the {MAX_HOME_XML_BYTES}-byte safety limit.")

    return parse_home_xml(payload)


def parse_home_xml(payload: bytes | str) -> Sh3dHome:
    xml_bytes = payload.encode("utf-8") if isinstance(payload, str) else payload
    upper = xml_bytes.upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise Sh3dFormatError("Home.xml must not declare a DTD or XML entities.")

    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError as error:
        raise Sh3dFormatError(f"Home.xml is not well-formed XML: {error}.") from error

    if root.tag != "home":
        raise Sh3dFormatError(f'Expected Home.xml root element "home", found "{root.tag}".')

    levels = tuple(_parse_level(node, index) for index, node in enumerate(root.findall("level")))
    furniture_nodes = [
        child
        for child in root
        if child.tag in {"pieceOfFurniture", "doorOrWindow", "light"}
    ]
    furniture = tuple(
        _parse_furniture(node, index) for index, node in enumerate(furniture_nodes)
    )
    walls = tuple(_parse_wall(node, index) for index, node in enumerate(root.findall("wall")))
    rooms = tuple(_parse_room(node, index) for index, node in enumerate(root.findall("room")))
    camera_nodes = [child for child in root if child.tag in {"camera", "observerCamera"}]
    cameras = tuple(_parse_camera(node, index) for index, node in enumerate(camera_nodes))

    unsupported = tuple(
        sorted(
            {
                child.tag
                for child in root
                if child.tag in {"furnitureGroup", "shelfUnit"}
            }
        )
    )

    return Sh3dHome(
        name=root.get("name"),
        version=_optional_int(root, "version"),
        default_wall_height_m=_optional_length(root, "wallHeight"),
        levels=levels,
        furniture=furniture,
        walls=walls,
        rooms=rooms,
        cameras=cameras,
        unsupported_elements=unsupported,
    )


def _parse_level(node: ElementTree.Element, ordinal: int) -> Sh3dLevel:
    elevation_index = _optional_int(node, "elevationIndex", default=-1)
    return Sh3dLevel(
        source=_source(node, ordinal),
        name=_required(node, "name"),
        elevation_m=_length(node, "elevation"),
        floor_thickness_m=_length(node, "floorThickness"),
        height_m=_length(node, "height"),
        elevation_index=-1 if elevation_index is None else elevation_index,
        visible=_boolean(node, "visible", default=True),
        viewable=_boolean(node, "viewable", default=True),
    )


def _parse_furniture(node: ElementTree.Element, ordinal: int) -> Sh3dFurniture:
    kind = node.tag
    if kind not in {"pieceOfFurniture", "doorOrWindow", "light"}:
        raise Sh3dFormatError(f'Unsupported furniture element "{kind}".')

    materials = tuple(_parse_material(material) for material in node.findall("material"))
    light_sources = tuple(
        _parse_light_source(light_source) for light_source in node.findall("lightSource")
    )

    wall_binding = None
    if kind == "doorOrWindow":
        wall_binding = Sh3dWallBinding(
            thickness_ratio=_float(node, "wallThickness", default=1.0),
            distance_ratio=_float(node, "wallDistance", default=0.0),
            width_ratio=_float(node, "wallWidth", default=1.0),
            left_ratio=_float(node, "wallLeft", default=0.0),
            height_ratio=_float(node, "wallHeight", default=1.0),
            top_ratio=_float(node, "wallTop", default=0.0),
            bound_to_wall=_boolean(node, "boundToWall", default=True),
        )

    return Sh3dFurniture(
        source=_source(node, ordinal),
        kind=kind,
        name=_required(node, "name"),
        level_id=node.get("level"),
        x_m=_length(node, "x"),
        y_m=_length(node, "y"),
        elevation_m=_length(node, "elevation", default=0.0),
        width_m=_length(node, "width"),
        depth_m=_length(node, "depth"),
        height_m=_length(node, "height"),
        angle_rad=_float(node, "angle", default=0.0),
        model_ref=node.get("model"),
        materials=materials,
        wall_binding=wall_binding,
        power=_float(node, "power", default=0.5) if kind == "light" else None,
        light_sources=light_sources,
    )


def _parse_material(node: ElementTree.Element) -> Sh3dMaterial:
    return Sh3dMaterial(
        name=_required(node, "name"),
        key=node.get("key"),
        color=_optional_int(node, "color"),
        shininess=_optional_float(node, "shininess"),
    )


def _parse_light_source(node: ElementTree.Element) -> Sh3dLightSource:
    return Sh3dLightSource(
        x_ratio=_float(node, "x"),
        y_ratio=_float(node, "y"),
        z_ratio=_float(node, "z"),
        color=_integer(node, "color"),
        diameter_ratio=_optional_float(node, "diameter"),
    )


def _parse_wall(node: ElementTree.Element, ordinal: int) -> Sh3dWall:
    return Sh3dWall(
        source=_source(node, ordinal),
        level_id=node.get("level"),
        wall_at_start_id=node.get("wallAtStart"),
        wall_at_end_id=node.get("wallAtEnd"),
        start=Sh3dPoint(
            x_m=_length(node, "xStart"),
            y_m=_length(node, "yStart"),
        ),
        end=Sh3dPoint(
            x_m=_length(node, "xEnd"),
            y_m=_length(node, "yEnd"),
        ),
        thickness_m=_length(node, "thickness"),
        height_m=_optional_length(node, "height"),
        height_at_end_m=_optional_length(node, "heightAtEnd"),
        arc_extent_rad=_optional_float(node, "arcExtent"),
    )


def _parse_room(node: ElementTree.Element, ordinal: int) -> Sh3dRoom:
    points = tuple(
        Sh3dPoint(
            x_m=_length(point, "x"),
            y_m=_length(point, "y"),
        )
        for point in node.findall("point")
    )
    if not points:
        raise Sh3dFormatError(f"{_source(node, ordinal).key} must contain at least one point.")

    return Sh3dRoom(
        source=_source(node, ordinal),
        name=node.get("name"),
        level_id=node.get("level"),
        points=points,
        floor_visible=_boolean(node, "floorVisible", default=True),
        ceiling_visible=_boolean(node, "ceilingVisible", default=True),
    )


def _parse_camera(node: ElementTree.Element, ordinal: int) -> Sh3dCamera:
    kind = node.tag
    if kind not in {"camera", "observerCamera"}:
        raise Sh3dFormatError(f'Unsupported camera element "{kind}".')

    return Sh3dCamera(
        source=_source(node, ordinal),
        kind=kind,
        name=node.get("name"),
        role=_required(node, "attribute"),
        x_m=_length(node, "x"),
        y_m=_length(node, "y"),
        z_m=_length(node, "z"),
        yaw_rad=_float(node, "yaw"),
        pitch_rad=_float(node, "pitch"),
        field_of_view_rad=_float(node, "fieldOfView"),
        lens=node.get("lens", "PINHOLE"),
        time_ms=_optional_int(node, "time"),
    )


def _source(node: ElementTree.Element, ordinal: int) -> Sh3dSourceRef:
    return Sh3dSourceRef(
        element=node.tag,
        source_id=node.get("id"),
        ordinal=ordinal,
    )


def _required(node: ElementTree.Element, name: str) -> str:
    value = node.get(name)
    if value is None:
        raise Sh3dFormatError(f'{node.tag} is missing required attribute "{name}".')
    return value


def _length(node: ElementTree.Element, name: str, *, default: float | None = None) -> float:
    return _float(node, name, default=default) * CENTIMETRES_TO_METRES


def _optional_length(node: ElementTree.Element, name: str) -> float | None:
    value = _optional_float(node, name)
    return None if value is None else value * CENTIMETRES_TO_METRES


def _float(node: ElementTree.Element, name: str, *, default: float | None = None) -> float:
    value = node.get(name)
    if value is None:
        if default is not None:
            return default
        raise Sh3dFormatError(f'{node.tag} is missing required numeric attribute "{name}".')
    try:
        return float(value)
    except ValueError as error:
        raise Sh3dFormatError(
            f'{node.tag} attribute "{name}" must be numeric, got "{value}".'
        ) from error


def _optional_float(node: ElementTree.Element, name: str) -> float | None:
    value = node.get(name)
    if value is None:
        return None
    try:
        return float(value)
    except ValueError as error:
        raise Sh3dFormatError(
            f'{node.tag} attribute "{name}" must be numeric, got "{value}".'
        ) from error


def _integer(node: ElementTree.Element, name: str) -> int:
    value = _required(node, name)
    return _parse_integer(node, name, value)


def _optional_int(
    node: ElementTree.Element,
    name: str,
    *,
    default: int | None = None,
) -> int | None:
    value = node.get(name)
    if value is None:
        return default
    return _parse_integer(node, name, value)


def _parse_integer(node: ElementTree.Element, name: str, value: str) -> int:
    try:
        return int(value, 0)
    except ValueError as error:
        raise Sh3dFormatError(
            f'{node.tag} attribute "{name}" must be an integer, got "{value}".'
        ) from error


def _boolean(node: ElementTree.Element, name: str, *, default: bool) -> bool:
    value = node.get(name)
    if value is None:
        return default
    if value == "true":
        return True
    if value == "false":
        return False
    raise Sh3dFormatError(
        f'{node.tag} attribute "{name}" must be "true" or "false", got "{value}".'
    )
