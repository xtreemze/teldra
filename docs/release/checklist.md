# Teldra release checklist

A release is blocked unless all applicable items pass.

## Source and reproducibility

- [ ] Release commit is immutable and identified in release metadata.
- [ ] `pnpm-lock.yaml` is committed and CI uses frozen pnpm resolution.
- [ ] `python/uv.lock` is committed and CI uses frozen uv resolution.
- [ ] Supported Node, pnpm, Python, uv, Blender, IfcOpenShell/Bonsai, and browser versions are recorded.
- [ ] Generated schemas/types are clean with no uncommitted regeneration.
- [ ] Release build is produced by CI from the release commit.

## Compatibility

- [ ] Every serialized schema/project-format version in supported fixtures validates.
- [ ] Known older formats either migrate through tested migrations or fail explicitly.
- [ ] Migration tests prove canonical Teldra IDs and IFC GlobalIds remain stable where identity is unchanged.
- [ ] Derived caches can be discarded/rebuilt without losing authored data.

## Security

- [ ] Archive/import limits match `release/policy.json`.
- [ ] Path traversal, absolute paths, archive symlinks, and decompression bombs are rejected.
- [ ] XML external entities/network resolution are disabled.
- [ ] Imported glTF does not gain implicit remote-network access.
- [ ] Fuzz/adversarial fixtures for supported importers pass.
- [ ] No real credentials exist in source, fixtures, logs, project examples, or generated artifacts.
- [ ] Dependency vulnerability review is complete.

## Licensing and provenance

- [ ] Repository license grant has explicit owner approval and complete license texts.
- [ ] Blender integration license zone is GPL-3.0-or-later if distributed as a Blender add-on.
- [ ] Clean-room SH3D provenance is documented; no Sweet Home GPL implementation code entered the portable core.
- [ ] Third-party dependency license inventory is generated.
- [ ] Models, textures, HDRIs, fonts, media, and example assets have redistributable provenance/licenses.
- [ ] Required notices/attributions are included.

## Quality and testing

- [ ] TypeScript and Python CI are green.
- [ ] Storybook interaction/accessibility tests are green.
- [ ] Required browser certification matrix is green.
- [ ] IFC/SH3D/golden-project end-to-end fixtures are green.
- [ ] Quality budgets in `quality/budgets.json` pass at their current enforcement level.
- [ ] Blender/Cycles reference tests pass when included in the release.

## Distribution

- [ ] SBOM generated.
- [ ] SHA-256 checksum manifest generated.
- [ ] CI provenance/attestation generated.
- [ ] Native packages/installers are signed/notarized where required.
- [ ] Release notes include schema/project compatibility and migration notes.
- [ ] Security-supported release window is stated.
