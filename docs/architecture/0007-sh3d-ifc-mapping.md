# ADR 0007: Sweet Home 3D to IFC mapping

Status: accepted

## Boundary

The SH3D parser remains independent of IFC. The IFC service remains independent of SH3D. A dedicated `teldra-import-sh3d` package owns conversion policy between them.

This prevents source-format assumptions from becoming canonical BIM behavior.

## Coordinate transform

Sweet Home 3D plan coordinates use `x` and `y` in the horizontal plane with elevation as the vertical coordinate. Its 3D runtime maps these into a right-handed Y-up scene by using `(x, elevation, y)` and negating furniture yaw around the vertical axis.

Teldra/IFC use a right-handed Z-up canonical frame. Preserving handedness therefore requires:

```text
X = source x
Y = -source y
Z = source elevation
yaw = -source angle
```

This transform is explicit, versioned through provenance metadata, and covered by tests. No renderer may silently apply a second axis conversion to canonical coordinates.

## Semantic mapping

The initial mapping is conservative:

- SH3D levels → `IfcBuildingStorey`
- SH3D rooms → `IfcSpace`
- straight SH3D walls → `IfcWall` with real body geometry
- ordinary furniture → `IfcFurniture`
- lights → `IfcLightFixture`
- SH3D `doorOrWindow` → `IfcBuildingElementProxy` until its actual architectural type and host opening can be established without guessing
- cameras remain presentation-side data and are returned by the importer rather than persisted as architectural IFC truth

Curved-wall body geometry may initially be deferred with an explicit warning rather than silently flattened.

## Provenance

Every mapped rooted IFC entity receives a custom `Teldra_Source` property set containing SH3D source identity and the applied coordinate transform.

The custom property set intentionally does not use the reserved `Pset_` prefix.

IFC GlobalIds remain the canonical architectural identities. SH3D IDs are source provenance used for repeatable re-import and future diff/reconciliation.

## Appearance

SH3D material and texture semantics remain available in the parsed source model, but their conversion into web/Blender PBR materials belongs to the separate Teldra asset/material interchange contract. The IFC mapping does not invent lossy appearance rules ahead of that contract.
