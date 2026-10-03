# Browser renderer fixtures

`twin-pick.glb` is a deliberately tiny deterministic glTF 2.0 binary fixture used only to certify the Babylon browser transport and picking boundary.

It contains one indexed cube (8 vertices / 36 indices) and one glTF node with:

- `extras.teldra.nodeKey = "ifc:fixture-wall:body"`
- `canonicalId = "wall:fixture"`
- a 22-character IFC-style GlobalId test value.

The file is 1,112 bytes and is not an architectural source fixture and is not intended to approximate the golden smart-home geometry. The Python exporter integration tests separately prove real IFC geometry → GLB identity preservation.

`blender-reference.glb` is the exact GLB produced by the pinned Blender reference pipeline for ADR 0009. It is duplicated from `fixtures/blender/reference/` only so the static Storybook server can load it directly; the Blender reference workflow byte-compares both copies. The Studio browser test loads this GLB and certifies canonical identity picking through Babylon.
