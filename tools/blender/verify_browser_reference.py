from __future__ import annotations

import argparse
import json
import struct
import zlib
from pathlib import Path
from typing import Iterable


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def paeth(left: int, above: int, upper_left: int) -> int:
    prediction = left + above - upper_left
    left_distance = abs(prediction - left)
    above_distance = abs(prediction - above)
    upper_left_distance = abs(prediction - upper_left)
    if left_distance <= above_distance and left_distance <= upper_left_distance:
        return left
    if above_distance <= upper_left_distance:
        return above
    return upper_left


def decode_png_rgb(path: Path) -> tuple[int, int, list[tuple[int, int, int, int]]]:
    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise AssertionError("Babylon screenshot is not a PNG")

    offset = len(PNG_SIGNATURE)
    idat = bytearray()
    width = height = bit_depth = color_type = interlace = None

    while offset + 12 <= len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        chunk_type = data[offset + 4 : offset + 8]
        chunk = data[offset + 8 : offset + 8 + length]
        offset += 12 + length

        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, _, _, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
        elif chunk_type == b"IDAT":
            idat.extend(chunk)
        elif chunk_type == b"IEND":
            break

    if width is None or height is None:
        raise AssertionError("Babylon screenshot has no IHDR")
    if bit_depth != 8:
        raise AssertionError(f"unsupported PNG bit depth: {bit_depth}")
    if color_type not in (2, 6):
        raise AssertionError(f"unsupported PNG color type: {color_type}")
    if interlace != 0:
        raise AssertionError("interlaced PNG is unsupported for certification")

    channels = 3 if color_type == 2 else 4
    row_size = width * channels
    raw = zlib.decompress(bytes(idat))
    expected = height * (row_size + 1)
    if len(raw) != expected:
        raise AssertionError(
            f"PNG decoded size mismatch: {len(raw)} != {expected}"
        )

    rows: list[bytearray] = []
    cursor = 0
    for _ in range(height):
        filter_type = raw[cursor]
        cursor += 1
        encoded = raw[cursor : cursor + row_size]
        cursor += row_size

        previous = rows[-1] if rows else bytearray(row_size)
        row = bytearray(row_size)
        for index, value in enumerate(encoded):
            left = row[index - channels] if index >= channels else 0
            above = previous[index]
            upper_left = previous[index - channels] if index >= channels else 0

            if filter_type == 0:
                reconstructed = value
            elif filter_type == 1:
                reconstructed = value + left
            elif filter_type == 2:
                reconstructed = value + above
            elif filter_type == 3:
                reconstructed = value + ((left + above) // 2)
            elif filter_type == 4:
                reconstructed = value + paeth(left, above, upper_left)
            else:
                raise AssertionError(f"unsupported PNG filter: {filter_type}")

            row[index] = reconstructed & 0xFF

        rows.append(row)

    pixels: list[tuple[int, int, int, int]] = []
    for row in rows:
        for index in range(0, len(row), channels):
            red, green, blue = row[index : index + 3]
            alpha = row[index + 3] if channels == 4 else 255
            pixels.append((red, green, blue, alpha))

    return width, height, pixels


def mean(values: Iterable[float]) -> float:
    data = list(values)
    if not data:
        raise AssertionError("metric has no samples")
    return sum(data) / len(data)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("babylon_png")
    parser.add_argument("cycles_metadata")
    args = parser.parse_args()

    width, height, pixels = decode_png_rgb(Path(args.babylon_png))
    if width < 500 or height < 300:
        raise AssertionError(
            f"Babylon canvas capture unexpectedly small: {width}x{height}"
        )

    opaque = [pixel for pixel in pixels if pixel[3] > 0]
    if not opaque:
        raise AssertionError("Babylon capture has no visible pixels")

    luminance = [
        (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
        for red, green, blue, _ in opaque
    ]
    red_mean = mean(red / 255 for red, _, _, _ in opaque)
    green_mean = mean(green / 255 for _, green, _, _ in opaque)
    blue_mean = mean(blue / 255 for _, _, blue, _ in opaque)

    browser_mean = mean(luminance)
    browser_contrast = max(luminance) - min(luminance)

    if not 0.02 < browser_mean < 0.95:
        raise AssertionError(
            f"Babylon mean luminance is implausible: {browser_mean}"
        )
    if browser_contrast <= 0.08:
        raise AssertionError(
            f"Babylon render has insufficient contrast: {browser_contrast}"
        )
    if blue_mean <= red_mean * 1.05:
        raise AssertionError(
            "Babylon render lost the blue-biased reference material"
        )

    cycles = json.loads(Path(args.cycles_metadata).read_text(encoding="utf8"))
    cycles_mean = float(cycles["metrics"]["meanLuminance"])
    cycles_contrast = float(cycles["metrics"]["contrast"])

    if abs(browser_mean - cycles_mean) > 0.45:
        raise AssertionError(
            "Babylon/Cycles mean luminance diverged beyond certification tolerance: "
            f"{browser_mean} vs {cycles_mean}"
        )
    if abs(browser_contrast - cycles_contrast) > 0.55:
        raise AssertionError(
            "Babylon/Cycles contrast diverged beyond certification tolerance: "
            f"{browser_contrast} vs {cycles_contrast}"
        )

    print(
        "Babylon reference visual metric OK: "
        f"{width}x{height}, mean={browser_mean:.6f}, "
        f"contrast={browser_contrast:.6f}, "
        f"rgb=({red_mean:.6f},{green_mean:.6f},{blue_mean:.6f}); "
        f"Cycles mean={cycles_mean:.6f}, contrast={cycles_contrast:.6f}"
    )


if __name__ == "__main__":
    main()
