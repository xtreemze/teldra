# Golden home fixture

This is the smallest shared Teldra smart-home fixture.

It currently proves:

- canonical building references use IFC GlobalIds;
- smart-home device identity remains separate from building identity;
- Home Assistant identity is an external binding;
- a light capability can be traced from fixture → device → adapter binding;
- scene nodes preserve canonical and IFC identity;
- appearance uses the portable metallic-roughness profile with UV0 for material textures;
- baked indirect lighting uses UV1 and linear-sRGB additive radiance bases;
- the floor lamp is bound to exactly one fixture-group radiance basis;
- reflection probes carry renderer-neutral canonical-space position/influence and multiple precomputed states;
- live state remains separate from persistent twin configuration;
- live fixtures cover light, opening, environmental sensor, and media capability values;
- desired light state is represented separately from observed physical state.

The hashes in the appearance/lighting manifests are deliberate deterministic fixture values. The referenced KTX2 files are not committed because this fixture currently certifies the interchange contract, not a real Cycles bake. Real reference assets will be introduced with the bake pipeline and must record actual hashes/toolchain provenance.

The files under `live/` are platform-neutral envelope examples. The light observation intentionally records `adapter: "home-assistant"`, but its values already use Teldra capability semantics; the external platform entity ID remains in the persistent binding rather than in live values.

All representations must preserve the canonical IDs established here rather than inventing renderer-specific identity.

Keep this fixture intentionally small. Larger performance/reference scenes belong in separate fixtures or external test assets.
