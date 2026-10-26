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
uv run python ../integrations/sweethome3d/export_visuals.py ../examples/21d-sweethome3d/21D.sh3d /path/to/visual-export --installation /path/to/SweetHome3D --java /path/to/java --javac /path/to/javac
uv run python ../tools/import/sh3d_to_project.py ../examples/21d-sweethome3d/21D.sh3d /path/to/21D.teldra --visual-export /path/to/visual-export
```

Open the resulting `.teldra` with Studio's **Open .teldra** button. The converter
refuses existing destinations and preserves the original SH3D bytes. The archive
contains IFC, a twin with source-derived reference IDs, a derived GLB/scene
manifest, a checksummed `import-report.json`, and the untouched original source
archive. No physical devices or adapter
bindings are inferred from furniture. This command creates a new project; it is
not a reconciliation/re-import command for an existing edited project.

The optional external producer uses the installed Sweet Home 3D public API to
export all levels, including hidden furniture, shelves, grouped objects, floors,
ceilings, and baseboards. The producer receives XML and embedded content only;
the Java-serialized `Home` entry is removed first. See
`integrations/sweethome3d/README.md` for runtime/compiler setup.

The portable converter preserves mesh positions, normals, UVs, material colors,
shininess, opacity, and image resolution. Ordinary image bytes are embedded
unchanged; ICC-tagged images are color-managed into glTF sRGB with alpha retained.
Original source images remain recoverable from `source.sh3d`. Studio recognizes
the source Phong material profile and preserves hidden-level visibility; use
**Show hidden source content** to reveal it. Visual parts resolve back to imported
IFC source identities; ground/background parts remain presentation geometry.

This preserves the authored visual assets, rather than claiming pixel-identical
lighting between Java 3D, Babylon, and offline renderers. Studio uses its own
interactive camera and preview lighting. The file picker accepts converted
`.teldra`, not raw `.sh3d`. The explicitly limited wall-only path remains available
with `--architecture-only`; the CLI requires choosing a conversion mode.
