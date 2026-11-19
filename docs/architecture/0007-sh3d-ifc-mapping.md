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
- SH3D `doorOrWindow` → `IfcDoor` or `IfcWindow` (name keywords, else floor-level elevation; the basis is recorded as `ClassificationBasis`). A bound door/window with exactly one host wall gets an `IfcOpeningElement` with a Body solid placed in the host wall's frame (`IfcRelVoidsElement`), and is placed in the opening's frame (`IfcRelFillsElement`). Zero or multiple candidate hosts, unbound pieces and clipped openings are reported in the import warnings and `bim.unhostedDoorsAndWindows`; the door/window itself is never dropped.
- SH3D rooms → `IfcSpace` with a `FootPrint` and an extruded `Body` (storey height); degenerate outlines keep identity and are reported.
- Straight walls carry a Body, an `Axis` representation and a single-layer `IfcMaterialLayerSetUsage` (offset 0; reference line = SH3D centreline, body on its left, as in `@teldra/ifc-edit`). `wallAtStart`/`wallAtEnd` links whose endpoints coincide become `IfcRelConnectsPathElements`; others are reported.
- Everything in `Home.xml` the parser does not model is listed in `import-report.json` `lossReport` (never silent).
- Re-import with an existing model keeps GlobalIds of source elements, hosted openings, project/site/building and `Teldra_Source` property sets.
- cameras remain presentation-side data and are returned by the importer rather than persisted as architectural IFC truth

Curved-wall body geometry may initially be deferred with an explicit warning rather than silently flattened.

## Provenance

Every mapped rooted IFC entity receives a custom `Teldra_Source` property set containing SH3D source identity and the applied coordinate transform.

The custom property set intentionally does not use the reserved `Pset_` prefix.

IFC GlobalIds remain the canonical architectural identities. SH3D IDs are source provenance used for repeatable re-import and future diff/reconciliation.

## Appearance

SH3D material and texture semantics remain available in the parsed source model, but their conversion into web/Blender PBR materials belongs to the separate Teldra asset/material interchange contract. The IFC mapping does not invent lossy appearance rules ahead of that contract.
