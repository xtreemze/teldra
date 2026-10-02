# ADR 0003: Portable .teldra project container

Status: proposed

## Shape

A released Teldra project should be movable as one file while keeping source truth separate from caches. The proposed `.teldra` format is a documented ZIP container:

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
