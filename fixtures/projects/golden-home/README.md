# Golden home fixture

This is the smallest shared Teldra smart-home project fixture.

Canonical/project files:

- `project.json` — portable project manifest with actual SHA-256 hashes for checked-in project artifacts;
- `building.ifc` — deterministic IFC4 generated from the SH3D source fixture;
- `twin.json` — canonical smart-home devices/capabilities/bindings;
- `identity-map.json` — source SH3D key → canonical Teldra ID → IFC GlobalId bridge.

Run:

```bash
cd python
uv run python ../tools/fixtures/generate_golden_home.py --check
```

to prove the generated files still match the checked-in source/toolchain.

It currently proves:

- canonical building references use IFC GlobalIds;
- the committed IFC covers storey, space, walls, furniture, light fixture, hosted opening, and placements;
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

The asset hashes inside the appearance/lighting semantic fixtures are deliberate deterministic sentinel values. Referenced GLB/KTX2 payloads are not committed because these fixtures currently certify interchange contracts, not a real Cycles bake. Real reference assets will be introduced with the bake pipeline and must record actual hashes/toolchain provenance.

The files under `live/` are platform-neutral envelope examples. The light observation intentionally records `adapter: "home-assistant"`, but its values already use Teldra capability semantics; the external platform entity ID remains in the persistent binding rather than in live values.

All representations must preserve the canonical IDs established here rather than inventing renderer-specific identity.

Keep this fixture intentionally small. Larger performance/reference scenes belong in separate fixtures or external test assets.
