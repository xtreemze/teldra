# Python toolchain

Python will host the IFC, Sweet Home 3D import, Blender automation, asset build, and bake pipelines.

Planned packages:

- `twin-ifc`: IfcOpenShell authoring, validation, identity, and migrations;
- `sh3d-importer`: semantic .sh3d/Home.xml import;
- `asset-pipeline`: GLB/KTX2/material processing and validation;
- `bake-pipeline`: Blender/Cycles radiance bases and reflection probes;
- `cli`: reproducible project import/build/validate/bake commands.

The Python workspace will be managed by uv. Python implementation starts after the serialization and identity contracts in this bootstrap are reviewed.
