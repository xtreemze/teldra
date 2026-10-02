# Sweet Home 3D golden fixture

This XML-only fixture is authored specifically for Teldra tests from the public Sweet Home 3D XML contract. It is not copied from a Sweet Home 3D project or implementation.

It covers:

- one level;
- four connected walls;
- one room;
- ordinary furniture;
- a door/window object with wall-binding ratios;
- a light and light source;
- material metadata;
- a stored camera.

Sweet Home 3D persists geometric lengths in centimetres. The Teldra semantic parser normalizes them to metres while preserving the source-frame coordinates and source IDs. Axis/origin conversion into canonical IFC placement is deliberately a separate, tested mapping step.
