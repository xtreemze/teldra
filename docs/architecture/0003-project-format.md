# ADR 0003: Portable .teldra project container

Status: accepted

## Shape

A released Teldra project is movable as one file while keeping source truth separate from caches. The `.teldra` format is a documented ZIP container:

```text
/project.json
/building.ifc
/twin.json
/assets/source/
/assets/textures/
/assets/models/
/appearance/materials.json
/cache/scene.glb
/cache/scene.manifest.json
/cache/lighting/
/cache/reflections/
```

Only `project.json`, `building.ifc`, `twin.json`, and authored assets are authoritative. `cache/` is disposable.

Derived artifacts must record the hashes and toolchain versions that produced them so stale bakes and exports can be invalidated deterministically.

Save, autosave, crash recovery, locking, backup, dirty-state, and corruption behavior are defined by ADR 0015. Host-local recovery data and filesystem/browser handles are never canonical project content.
