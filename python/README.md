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
