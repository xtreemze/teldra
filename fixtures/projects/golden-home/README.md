# Golden home fixture

This is the smallest shared Teldra smart-home fixture.

It currently proves the serialized twin boundary:

- canonical building references use IFC GlobalIds;
- smart-home device identity remains separate from building identity;
- Home Assistant identity is an external binding;
- a light capability can be traced from fixture → device → adapter binding.

The IFC, scene manifest, GLB, lighting, and Home Assistant state fixtures will be added incrementally by issues #3, #5, #10, and #11. All representations must preserve the canonical IDs established here rather than inventing renderer-specific identity.

Keep this fixture intentionally small. Larger performance/reference scenes belong in separate fixtures or external test assets.
