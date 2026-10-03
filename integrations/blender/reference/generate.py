from __future__ import annotations

import argparse
import base64
import hashlib
import json
import struct
import sys
from pathlib import Path

import bpy

JSON_CHUNK = 0x4E4F534A
CANONICAL_TO_GLTF = [
    1.0, 0.0, 0.0, 0.0,
    0.0, 0.0, -1.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_glb_json(path: Path) -> dict:
    data = path.read_bytes()
    if len(data) < 20:
        raise RuntimeError("GLB is too small.")
    magic, version, total_length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or total_length != len(data):
        raise RuntimeError("Unexpected GLB header.")
    chunk_length, chunk_type = struct.unpack_from("<II", data, 12)
    if chunk_type != JSON_CHUNK:
        raise RuntimeError("First GLB chunk is not JSON.")
    payload = data[20 : 20 + chunk_length].rstrip(b" \t\r\n\x00")
    value = json.loads(payload.decode("utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("GLB JSON root must be an object.")
    return value


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.lights,
        bpy.data.cameras,
    ):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def create_reference_mesh(source: dict):
    size = float(source["geometry"]["sizeMetres"])
    half = size / 2.0
    mesh = bpy.data.meshes.new("TeldraReferenceMesh")
    mesh.from_pydata(
        [
            (-half, -half, 0.0),
            (half, -half, 0.0),
            (half, half, 0.0),
            (-half, half, 0.0),
        ],
        [],
        [(0, 1, 2, 3)],
    )
    mesh.update()

    uv_values = {
        0: (0.0, 0.0),
        1: (1.0, 0.0),
        2: (1.0, 1.0),
        3: (0.0, 1.0),
    }
    for name in ("UVMap", "Lightmap"):
        layer = mesh.uv_layers.new(name=name)
        for polygon in mesh.polygons:
            for loop_index in polygon.loop_indices:
                vertex_index = mesh.loops[loop_index].vertex_index
                layer.data[loop_index].uv = uv_values[vertex_index]

    obj = bpy.data.objects.new("TeldraBlenderReference", mesh)
    bpy.context.collection.objects.link(obj)
    obj["teldra"] = {
        "nodeKey": source["nodeKey"],
        "canonicalId": source["canonicalId"],
        "ifcGlobalId": source["ifcGlobalId"],
    }
    return obj


def create_material(obj, source: dict):
    material_spec = source["material"]
    material = bpy.data.materials.new("TeldraReferencePBR")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf is None:
        raise RuntimeError("Blender did not create a Principled BSDF node.")

    bsdf.inputs["Base Color"].default_value = tuple(material_spec["baseColor"])
    bsdf.inputs["Metallic"].default_value = float(material_spec["metallic"])
    bsdf.inputs["Roughness"].default_value = float(material_spec["roughness"])
    obj.data.materials.append(material)
    return material


def create_light() -> None:
    light_data = bpy.data.lights.new("TeldraReferenceArea", type="AREA")
    light_data.energy = 700.0
    light_data.shape = "DISK"
    light_data.size = 2.0
    light = bpy.data.objects.new("TeldraReferenceArea", light_data)
    light.location = (0.0, 0.0, 2.0)
    bpy.context.collection.objects.link(light)


def bake_lightmap(obj, material, source: dict, destination: Path) -> None:
    bake_spec = source["bake"]
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    try:
        scene.render.engine = "CYCLES"
    except TypeError as error:
        raise RuntimeError("Cycles is unavailable in this Blender build.") from error

    scene.cycles.samples = int(bake_spec["samples"])
    scene.cycles.use_denoising = False
    scene.render.bake.margin = int(bake_spec["marginPixels"])
    scene.render.bake.use_clear = True

    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("TeldraReferenceWorld")
        scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background is not None:
        background.inputs["Color"].default_value = (0.04, 0.04, 0.04, 1.0)
        background.inputs["Strength"].default_value = 0.35

    image = bpy.data.images.new(
        "TeldraReferenceLightmap",
        width=int(bake_spec["width"]),
        height=int(bake_spec["height"]),
        alpha=False,
        float_buffer=True,
    )

    nodes = material.node_tree.nodes
    links = material.node_tree.links
    image_node = nodes.new("ShaderNodeTexImage")
    image_node.name = "TeldraReferenceBakeTarget"
    image_node.image = image

    uv_node = nodes.new("ShaderNodeUVMap")
    uv_node.uv_map = "Lightmap"
    links.new(uv_node.outputs["UV"], image_node.inputs["Vector"])

    for node in nodes:
        node.select = False
    image_node.select = True
    nodes.active = image_node

    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    bpy.ops.object.bake(
        type="DIFFUSE",
        pass_filter={"DIRECT", "INDIRECT", "COLOR"},
        use_clear=True,
        margin=int(bake_spec["marginPixels"]),
    )

    image.filepath_raw = str(destination)
    image.file_format = "PNG"
    image.save()


def export_glb(obj, destination: Path) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    result = bpy.ops.export_scene.gltf(
        filepath=str(destination),
        export_format="GLB",
        export_yup=True,
        export_extras=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        use_selection=True,
    )
    if "FINISHED" not in result:
        raise RuntimeError(f"glTF export failed: {result!r}")


def certify_glb(glb: dict, source: dict) -> dict:
    expected_identity = {
        "nodeKey": source["nodeKey"],
        "canonicalId": source["canonicalId"],
        "ifcGlobalId": source["ifcGlobalId"],
    }

    matched_node = None
    for node in glb.get("nodes", []):
        extras = node.get("extras") if isinstance(node, dict) else None
        if isinstance(extras, dict) and extras.get("teldra") == expected_identity:
            matched_node = node
            break
    if matched_node is None:
        raise RuntimeError("Exported GLB did not preserve extras.teldra identity.")

    mesh_index = matched_node.get("mesh")
    if not isinstance(mesh_index, int):
        raise RuntimeError("Reference node did not export a mesh.")
    primitive = glb["meshes"][mesh_index]["primitives"][0]
    attributes = primitive.get("attributes", {})
    if "TEXCOORD_0" not in attributes or "TEXCOORD_1" not in attributes:
        raise RuntimeError("Exported GLB must preserve both UV0 and UV1.")

    material_index = primitive.get("material")
    if not isinstance(material_index, int):
        raise RuntimeError("Reference primitive has no material.")
    pbr = glb["materials"][material_index].get("pbrMetallicRoughness", {})

    expected_material = source["material"]
    base_color = pbr.get("baseColorFactor")
    metallic = pbr.get("metallicFactor")
    roughness = pbr.get("roughnessFactor")

    if base_color is None or any(
        abs(float(actual) - float(expected)) > 1e-5
        for actual, expected in zip(base_color, expected_material["baseColor"], strict=True)
    ):
        raise RuntimeError("Unexpected glTF baseColorFactor.")
    if metallic is None or abs(float(metallic) - float(expected_material["metallic"])) > 1e-5:
        raise RuntimeError("Unexpected glTF metallicFactor.")
    if roughness is None or abs(float(roughness) - float(expected_material["roughness"])) > 1e-5:
        raise RuntimeError("Unexpected glTF roughnessFactor.")

    return {
        "nodeIndex": glb["nodes"].index(matched_node),
        "meshIndex": mesh_index,
        "materialIndex": material_index,
        "attributes": sorted(attributes),
        "pbrMetallicRoughness": {
            "baseColorFactor": base_color,
            "metallicFactor": metallic,
            "roughnessFactor": roughness,
        },
    }


def write_outputs(source_path: Path, output_dir: Path) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    source = json.loads(source_path.read_text(encoding="utf-8"))

    reset_scene()
    obj = create_reference_mesh(source)
    material = create_material(obj, source)
    create_light()

    bake_path = output_dir / "blender-reference-bake.png"
    glb_path = output_dir / "blender-reference.glb"
    bake_lightmap(obj, material, source, bake_path)
    export_glb(obj, glb_path)

    glb = read_glb_json(glb_path)
    certification = certify_glb(glb, source)

    scene_manifest = {
        "schemaVersion": "0.1.0",
        "coordinateSystem": {
            "unit": "metre",
            "handedness": "right",
            "upAxis": "Z",
        },
        "source": {
            "buildingPath": source_path.name,
            "buildingSha256": sha256(source_path),
        },
        "scene": {
            "assetPath": glb_path.name,
            "assetSha256": sha256(glb_path),
            "format": "glb",
            "canonicalToScene": CANONICAL_TO_GLTF,
        },
        "nodes": [
            {
                "nodeKey": source["nodeKey"],
                "canonicalId": source["canonicalId"],
                "ifcGlobalId": source["ifcGlobalId"],
                "kind": "building",
                "renderPart": "body",
            }
        ],
    }
    scene_path = output_dir / "blender-reference.scene.manifest.json"
    scene_path.write_text(
        json.dumps(scene_manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    metadata = {
        "schemaVersion": "0.1.0",
        "blenderVersion": bpy.app.version_string,
        "blenderVersionTuple": list(bpy.app.version),
        "blenderBuildHash": bpy.app.build_hash.decode("ascii", errors="replace")
        if isinstance(bpy.app.build_hash, bytes)
        else str(bpy.app.build_hash),
        "cyclesVersion": bpy.app.version_string,
        "pipelineVersion": "0.1.0",
        "colorManagement": {
            "materialBaseColorTransfer": "srgb",
            "materialDataTransfer": "linear",
            "bakeWorkingSpace": "linear-srgb",
        },
        "uvSets": {
            "material": 0,
            "lightmap": 1,
        },
        "runtimeDelivery": {
            "geometry": "glb",
            "bakedLightingTarget": "ktx2",
            "referenceBakeIntermediate": "png",
        },
        "hashes": {
            "sourceSha256": sha256(source_path),
            "glbSha256": sha256(glb_path),
            "bakeSha256": sha256(bake_path),
            "sceneManifestSha256": sha256(scene_path),
        },
        "certification": certification,
    }
    metadata_path = output_dir / "blender-reference.metadata.json"
    metadata_path.write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    return [glb_path, bake_path, scene_path, metadata_path]


def emit_base64(paths: list[Path]) -> None:
    for path in paths:
        print(f"TELDRA_BLENDER_BEGIN:{path.name}")
        print(base64.b64encode(path.read_bytes()).decode("ascii"))
        print(f"TELDRA_BLENDER_END:{path.name}")


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--emit-base64", action="store_true")
    args = parser.parse_args(argv)

    paths = write_outputs(args.source.resolve(), args.output.resolve())
    if args.emit_base64:
        emit_base64(paths)


if __name__ == "__main__":
    main()
