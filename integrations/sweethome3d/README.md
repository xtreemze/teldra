# Optional native visual producer

This separate producer invokes an independently installed Sweet Home 3D through
its documented public Java APIs. No Sweet Home implementation code, JARs, native
libraries, Java runtime, or compiler is bundled in Teldra's portable core.
Sweet Home 3D is GPL-2.0-or-later; this integration is a separate license zone
whose distribution must be reviewed under ADR 0012 before a product release.

Validated locally with Sweet Home 3D 7.5, its bundled 32-bit Java 8 runtime, and
Eclipse ECJ 3.26.0 as a local compiler. Use Java matching the installation's native
library architecture. A JDK `javac` can compile the wrapper instead; the class
target is Java 8. Runtime heap defaults to 1200 MB for the reference scene.

From `python/` after `uv sync --group dev`:

```bash
uv run python ../integrations/sweethome3d/export_visuals.py source.sh3d /path/to/visual-export --installation /path/to/SweetHome3D --java /path/to/java --javac /path/to/javac
uv run python ../tools/import/sh3d_to_project.py source.sh3d destination.teldra --visual-export /path/to/visual-export
```

For an existing Eclipse compiler JAR, replace `--javac` with
`--compiler-jar /path/to/ecj.jar`. The producer never downloads tools or changes
the installed application. Existing output directories/projects are refused.

The producer validates archive paths, sizes, duplicate entries, encryption,
compression ratios, XML declarations, and embedded resource references. It builds
a temporary archive without the Java-serialized `Home` entry. The public XML API
loads that archive and exports the native visual geometry, including hidden
levels. Stable source IDs and original level visibility are carried in explicit
producer tags, then transferred to glTF metadata. Java object deserialization is
not an import path.

`visual-export.json` binds source SHA-256, producer JAR SHA-256, and every emitted
asset hash. The portable converter verifies that receipt before consuming OBJ/MTL
and refuses a source mismatch, asset tampering, missing textures, or unaccounted
furniture. It preserves fully transparent source records without inventing opaque
geometry. Native visual geometry is a derived projection; IFC and twin contracts
retain authority. This is a new-project import, not reconciliation of edited IFC.

API references:
- https://www.sweethome3d.com/javadoc/com/eteks/sweethome3d/io/DefaultHomeInputStream.html
- https://www.sweethome3d.com/javadoc/com/eteks/sweethome3d/swing/HomePane.html
- https://www.sweethome3d.com/javadoc/com/eteks/sweethome3d/j3d/Object3DBranchFactory.html

Native producer certification requires an installed application and is run
locally. CI uses authored synthetic transport, parser, archive-boundary, Phong,
texture/UV/alpha, hidden-content, and browser regression fixtures.
