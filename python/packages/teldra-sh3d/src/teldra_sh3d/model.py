from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class Sh3dSourceRef:
    element: str
    source_id: str | None
    ordinal: int

    @property
    def key(self) -> str:
        if self.source_id is not None:
            return f"{self.element}:{self.source_id}"
        return f"{self.element}[{self.ordinal}]"


@dataclass(frozen=True, slots=True)
class Sh3dPoint:
    x_m: float
    y_m: float


@dataclass(frozen=True, slots=True)
class Sh3dLevel:
    source: Sh3dSourceRef
    name: str
    elevation_m: float
    floor_thickness_m: float
    height_m: float
    elevation_index: int
    visible: bool
    viewable: bool


@dataclass(frozen=True, slots=True)
class Sh3dMaterial:
    name: str
    key: str | None
    color: int | None
    shininess: float | None


@dataclass(frozen=True, slots=True)
class Sh3dLightSource:
    x_ratio: float
    y_ratio: float
    z_ratio: float
    color: int
    diameter_ratio: float | None


@dataclass(frozen=True, slots=True)
class Sh3dWallBinding:
    thickness_ratio: float
    distance_ratio: float
    width_ratio: float
    left_ratio: float
    height_ratio: float
    top_ratio: float
    bound_to_wall: bool


@dataclass(frozen=True, slots=True)
class Sh3dFurniture:
    source: Sh3dSourceRef
    kind: Literal["pieceOfFurniture", "doorOrWindow", "light"]
    name: str
    level_id: str | None
    x_m: float
    y_m: float
    elevation_m: float
    width_m: float
    depth_m: float
    height_m: float
    angle_rad: float
    model_ref: str | None
    materials: tuple[Sh3dMaterial, ...]
    wall_binding: Sh3dWallBinding | None
    power: float | None
    light_sources: tuple[Sh3dLightSource, ...]


@dataclass(frozen=True, slots=True)
class Sh3dWall:
    source: Sh3dSourceRef
    level_id: str | None
    wall_at_start_id: str | None
    wall_at_end_id: str | None
    start: Sh3dPoint
    end: Sh3dPoint
    thickness_m: float
    height_m: float | None
    height_at_end_m: float | None
    arc_extent_rad: float | None


@dataclass(frozen=True, slots=True)
class Sh3dRoom:
    source: Sh3dSourceRef
    name: str | None
    level_id: str | None
    points: tuple[Sh3dPoint, ...]
    floor_visible: bool
    ceiling_visible: bool


@dataclass(frozen=True, slots=True)
class Sh3dCamera:
    source: Sh3dSourceRef
    kind: Literal["camera", "observerCamera"]
    name: str | None
    role: str
    x_m: float
    y_m: float
    z_m: float
    yaw_rad: float
    pitch_rad: float
    field_of_view_rad: float
    lens: str
    time_ms: int | None


@dataclass(frozen=True, slots=True)
class Sh3dHome:
    name: str | None
    version: int | None
    default_wall_height_m: float | None
    levels: tuple[Sh3dLevel, ...]
    furniture: tuple[Sh3dFurniture, ...]
    walls: tuple[Sh3dWall, ...]
    rooms: tuple[Sh3dRoom, ...]
    cameras: tuple[Sh3dCamera, ...]
    unsupported_elements: tuple[str, ...]
