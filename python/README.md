# Teldra Python workspace

The Python workspace owns IFC manipulation, Sweet Home 3D import, Blender/offline asset automation, and future build/bake tooling. Canonical application semantics remain language-neutral through the checked-in Teldra schemas.

## Toolchain

- Python 3.12
- uv 0.12.19
- IfcOpenShell 0.9.0
- pytest
- Ruff

## Commands

From `python/`:

```bash
uv sync --group dev
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

The first package, `teldra-ifc`, deliberately does not depend on Blender or Bonsai. It creates and edits canonical IFC through IfcOpenShell so the same services can later be called by Blender, importers, CLI tools, and tests.

## Open a Sweet Home 3D source in Studio

From `python/`, after syncing the workspace:

```bash
uv run python ../tools/import/sh3d_to_project.py ../examples/21d-sweethome3d/21D.sh3d /path/to/21D.teldra
```

Open the resulting `.teldra` with Studio's **Open .teldra** button. The converter
refuses existing destinations and preserves the original SH3D bytes. The archive
contains IFC, a twin with source-derived reference IDs, a derived GLB/scene
manifest, and a checksummed `import-report.json`. No physical devices or adapter
bindings are inferred from furniture. This command creates a new project; it is
not a reconciliation/re-import command for an existing edited project.

This is a limited semantic/architectural import. Supported walls are rendered;
furniture models, textures, grouped furniture, shelf units, and original cameras
are not reproduced in Studio. Inspect the warnings before relying on the result.
The Studio file picker does not directly accept `.sh3d` files.
