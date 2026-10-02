# ADR 0008: Derived scene manifest and renderer identity

Status: accepted

## Decision

Teldra web scenes use a versioned `scene.manifest.json` beside the derived GLB.

The manifest is not architectural authority. It is a reproducible transport contract that maps derived renderer nodes back to Teldra canonical identity and IFC GlobalIds.

## Identity

A canonical object may produce multiple renderer nodes. Therefore:

- `nodeKey` is unique inside one scene manifest;
- `canonicalId` is intentionally one-to-many;
- building nodes preserve `ifcGlobalId`;
- non-building nodes must not impersonate IFC identity;
- `renderPart` distinguishes body, label anchor, helper, or other derived parts when useful.

The exporter must embed the same `nodeKey` into the matching GLB node `extras.teldra` metadata so runtime picking can resolve through the manifest without depending on node array indices or human-readable names.

## Coordinates

The manifest records the canonical-to-scene transform explicitly and follows ADR 0005. Teldra canonical/project space remains metres, right-handed, and Z-up. glTF is transported as right-handed Y-up.

All 4×4 matrices in scene manifests use column-major array layout.

The baseline canonical-to-glTF transform rotates -90° about X:

```text
canonical (x, y, z) -> glTF (x, z, -y)
```

Exporters may introduce additional transport transforms only when they are recorded explicitly in the manifest.

Per-node canonical transforms are optional because the GLB already carries local scene transforms; they are included when a consumer needs an independently verifiable canonical placement.

## Geometry conversion

The baseline exporter uses IfcOpenShell's geometry iterator and official glTF/GLB serializer. Teldra does not maintain a competing IFC triangulation engine.

After serialization, Teldra rewrites only the GLB JSON chunk to attach canonical identity metadata. Binary geometry chunks remain unchanged.

## Hashes and invalidation

The source IFC and derived GLB are referenced with SHA-256 hashes. A scene manifest is stale if its recorded hashes no longer match the authoritative source or derived asset.

The placeholder hashes in committed fixture manifests represent contract fixtures, not generated production artifacts.

## Lighting

The scene manifest only points to a future lighting manifest. Radiance bases, reflection probes, material interchange, texture color spaces, and bake provenance remain specified under #10 rather than being coupled into renderer identity.
