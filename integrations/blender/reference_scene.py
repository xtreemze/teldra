from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector


NODE_KEY = "reference:blender-cube:body"
CANONICAL_ID = "fixture:blender-reference-cube"
MATERIAL_KEY = "reference-blue-metallic-roughness"


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args(argv)


def point_at(obj: bpy.types.Object, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def reset_scene() -> bpy.types.Scene:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 8
    scene.cycles.use_denoising = False
    scene.render.resolution_x = 64
    scene.render.resolution_y = 64
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.world.color = (0.03, 0.03, 0.03)
    return scene


def add_reference_cube() -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0.0, 0.0, 1.0))
    cube = bpy.context.object
    cube.name = "TeldraReferenceCube"

    if len(cube.data.uv_layers) == 0:
        cube.data.uv_layers.new(name="UVMap")
    else:
        cube.data.uv_layers[0].name = "UVMap"
    cube.data.uv_layers.new(name="LightmapUV")

    material = bpy.data.materials.new(name=MATERIAL_KEY)
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled is None:
        raise RuntimeError("Principled BSDF node is unavailable")

    principled.inputs["Base Color"].default_value = (0.12, 0.34, 0.72, 1.0)
    principled.inputs["Metallic"].default_value = 0.2
    principled.inputs["Roughness"].default_value = 0.45
    cube.data.materials.append(material)

    cube["teldra"] = {
        "nodeKey": NODE_KEY,
        "canonicalId": CANONICAL_ID,
        "materialKey": MATERIAL_KEY,
    }
    return cube


def add_floor() -> bpy.types.Object:
    bpy.ops.mesh.primitive_plane_add(size=10.0, location=(0.0, 0.0, 0.0))
    floor = bpy.context.object
    floor.name = "ReferenceFloor"

    material = bpy.data.materials.new(name="reference-floor")
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled is None:
        raise RuntimeError("Principled BSDF node is unavailable")
    principled.inputs["Base Color"].default_value = (0.18, 0.18, 0.18, 1.0)
    principled.inputs["Roughness"].default_value = 0.8
    floor.data.materials.append(material)
    return floor


def add_camera_and_light(scene: bpy.types.Scene) -> None:
    bpy.ops.object.camera_add(location=(4.2, -4.2, 3.2))
    camera = bpy.context.object
    point_at(camera, Vector((0.0, 0.0, 0.9)))
    scene.camera = camera

    bpy.ops.object.light_add(type="AREA", location=(2.5, -1.5, 5.0))
    key = bpy.context.object
    key.data.energy = 850.0
    key.data.shape = "DISK"
    key.data.size = 3.0
    point_at(key, Vector((0.0, 0.0, 0.8)))

    bpy.ops.object.light_add(type="AREA", location=(-3.0, 2.0, 2.5))
    fill = bpy.context.object
    fill.data.energy = 250.0
    fill.data.size = 2.0
    point_at(fill, Vector((0.0, 0.0, 0.8)))


def render_metrics(scene: bpy.types.Scene, output_dir: Path) -> dict[str, object]:
    render_path = output_dir / "reference-cycles.png"
    scene.render.filepath = str(render_path)
    bpy.ops.render.render(write_still=True)

    render = bpy.data.images.get("Render Result")
    if render is None:
        raise RuntimeError("Render Result is unavailable")

    pixels = list(render.pixels)
    if len(pixels) < 4 or len(pixels) % 4 != 0:
        raise RuntimeError("Render Result has an invalid RGBA buffer")

    luminance: list[float] = []
    alpha_values: list[float] = []
    for index in range(0, len(pixels), 4):
        red, green, blue, alpha = pixels[index : index + 4]
        luminance.append(0.2126 * red + 0.7152 * green + 0.0722 * blue)
        alpha_values.append(alpha)

    if len(luminance) == 0:
        raise RuntimeError("Render Result contains no pixels")

    mean = sum(luminance) / len(luminance)
    minimum = min(luminance)
    maximum = max(luminance)

    return {
        "width": scene.render.resolution_x,
        "height": scene.render.resolution_y,
        "meanLuminance": mean,
        "minLuminance": minimum,
        "maxLuminance": maximum,
        "contrast": maximum - minimum,
        "meanAlpha": sum(alpha_values) / len(alpha_values),
        "samples": scene.cycles.samples,
        "engine": scene.render.engine,
        "device": scene.cycles.device,
        "renderPath": render_path.name,
    }


def export_glb(output_dir: Path) -> Path:
    glb_path = output_dir / "reference.blender.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        export_extras=True,
        export_yup=True,
        export_materials="EXPORT",
    )
    return glb_path


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    scene = reset_scene()
    add_reference_cube()
    add_floor()
    add_camera_and_light(scene)

    metrics = render_metrics(scene, output_dir)
    glb_path = export_glb(output_dir)

    build_hash = bpy.app.build_hash
    if isinstance(build_hash, bytes):
        build_hash = build_hash.decode("utf8", errors="replace")

    metadata = {
        "schemaVersion": "0.1.0",
        "blenderVersion": bpy.app.version_string,
        "cyclesVersion": bpy.app.version_string,
        "buildHash": str(build_hash),
        "nodeKey": NODE_KEY,
        "canonicalId": CANONICAL_ID,
        "materialKey": MATERIAL_KEY,
        "glbPath": glb_path.name,
        "metrics": metrics,
    }
    (output_dir / "reference.metadata.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf8",
    )


if __name__ == "__main__":
    main()
