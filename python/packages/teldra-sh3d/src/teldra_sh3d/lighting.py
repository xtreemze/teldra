"""Derived interactive light sources, in the exported scene's metre/Y-up frame."""

from math import cos, sin

from .model import Sh3dFurniture, Sh3dHome


def source_lighting(home: Sh3dHome) -> dict:
    levels = {level.source.source_id: level for level in home.levels}
    lamps, windows = [], []
    for piece in home.furniture:
        level = levels.get(piece.level_id)
        if not piece.visible or (level is not None and not (level.visible and level.viewable)):
            continue
        elevation = piece.elevation_m + (level.elevation_m if level else 0)

        if piece.kind == "light":
            for source in piece.light_sources:
                lamps.append(
                    {
                        "canonicalId": f"sh3d:{piece.source.key}",
                        "position": _position(
                            piece, elevation, source.x_ratio, source.y_ratio, source.z_ratio
                        ),
                        "color": source.color,
                        "power": piece.power or 0,
                    }
                )
        # SH3D doorOrWindow has no universal window boolean. Only explicitly named
        # windows contribute derived daylight; doors are never inferred as windows.
        elif piece.kind == "doorOrWindow" and "window" in piece.name.casefold():
            windows.append(
                {
                    "canonicalId": f"sh3d:{piece.source.key}",
                    "position": _position(piece, elevation, 0.5, 0.5, 0.5),
                    "color": home.preview_sky_color,
                    "power": 0.65,
                }
            )
    return {
        "profile": "sh3d-preview-v1",
        "lightColor": home.preview_light_color,
        "skyColor": home.preview_sky_color,
        "pointSources": lamps,
        "windowSources": windows,
    }


def _position(piece: Sh3dFurniture, elevation: float, x: float, y: float, z: float) -> list[float]:
    c, s = cos(piece.angle_rad), sin(piece.angle_rad)
    dx = (x - 0.5) * piece.width_m * (-1 if piece.model_mirrored else 1)
    dy = (y - 0.5) * piece.depth_m
    # SH3D XY -> canonical X,-Y,Z -> scene X,Z,-Y.
    return [
        piece.x_m + dx * c - dy * s,
        elevation + z * piece.height_m,
        piece.y_m + dx * s + dy * c,
    ]
