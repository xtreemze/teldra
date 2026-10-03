# Teldra fixture corpus

Fixtures are synthetic, deterministic test data. They must not contain real user projects, credentials, private-home telemetry, copied third-party assets, or implementation code from compatibility targets.

`corpus.json` is the machine-readable index. Every fixture group records provenance, licensing status, and the invariants it exists to certify.

## Golden home

The shared golden home spans the same conceptual home through:

```text
SH3D Home.xml
  -> deterministic IFC4 building.ifc
  -> canonical twin.json
  -> identity-map.json
  -> derived scene / appearance / lighting manifests
  -> platform-neutral live-state envelopes
```

`tools/fixtures/generate_golden_home.py` regenerates the IFC, identity map, and project manifest. CI uses `--check` and fails when the committed bytes no longer match the current importer/toolchain.

The generated IFC deliberately preserves the established living-room and floor-lamp GlobalIds used by the twin and scene fixtures. Other IFC root IDs are UUIDv5-derived and compressed to IFC GUID form so regeneration is stable.

## Licensing and provenance

Repository-authored fixtures follow the repository's eventual license grant. Until that release license is finalized, fixture metadata describes them as repository-owned test fixtures rather than asserting a separate permissive license.

The SH3D fixture is authored from scratch against the public file-format contract. Do not introduce Sweet Home 3D implementation code or copied project assets.

All generated or imported fixtures must record their source and generator. Third-party reference assets require explicit license metadata before they enter the corpus.

## Large binaries and reference images

Keep small deterministic semantic fixtures in Git when they are necessary for cross-runtime certification.

For large GLB, texture, bake, video, or reference-image assets:

1. keep the smallest source fixture and deterministic generator/configuration in Git;
2. record SHA-256, producer/toolchain provenance, and license metadata;
3. do not commit a large binary merely for convenience—its storage must be explicitly reviewed;
4. prefer CI-generated artifacts for transient certification data;
5. if a reference image is committed, keep it bounded, deterministic, license-cleared, and tied to a stated visual invariant.

Performance-scale scenes belong in separate fixtures from the tiny golden home.
