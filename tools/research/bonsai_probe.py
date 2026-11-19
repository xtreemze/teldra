"""Headless probe: enable Bonsai in Blender, open an IFC through Bonsai's own operator,
report versions and what Bonsai sees. Run:
  blender -b --python tools/research/bonsai_probe.py -- <path/to/model.ifc>
Requires the Bonsai extension installed and enabled; see
docs/research/capability-matrix.md for the exact install commands.
"""
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
ifc_path = argv[0]

print("PROBE blender", bpy.app.version_string, "python", sys.version.split()[0])
try:  # `extension install -e bonsai` already enables it; this is a belt-and-braces fallback
    import bonsai  # noqa: F401
except ImportError:
    for module in ("bl_ext.blender_org.bonsai", "bl_ext.bonsai_unstable.bonsai"):
        try:
            bpy.ops.preferences.addon_enable(module=module)
            break
        except Exception as e:  # noqa: BLE001
            print("PROBE enable error", module, e)

import bonsai.tool as tool  # noqa: E402
import ifcopenshell  # noqa: E402

print("PROBE bundled ifcopenshell", ifcopenshell.version)
bpy.ops.bim.load_project(filepath=ifc_path, should_start_fresh_session=True)
f = tool.Ifc.get()
print("PROBE schema", f.schema, "entities", len(list(f)))
for t in ("IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcSpace", "IfcDoor", "IfcWindow",
          "IfcOpeningElement", "IfcFurnishingElement", "IfcBuildingStorey"):
    print("PROBE", t, len(f.by_type(t, include_subtypes=False)))
print("PROBE blender objects", len(bpy.data.objects))
