# ADR 0012: Release, security, compatibility, and licensing

Status: accepted

## Release authority

`release/policy.json` is the machine-readable authority for release gates. Human release procedure lives in `docs/release/checklist.md`.

Teldra uses semantic versioning for product releases. Serialized formats are independently versioned and never infer compatibility from application version alone.

Before 1.0, format evolution may still be rapid, but a released schema must never become silently unreadable: an older known version must either have a tested migration or fail with an explicit actionable compatibility error.

Derived caches may always be invalidated and rebuilt. Canonical IFC identity and Teldra canonical IDs may not be replaced merely because a project was migrated.

## Reproducibility

A public release requires committed JavaScript and Python lockfiles, a pinned toolchain manifest, clean generated schemas, and an exact source commit.

The repository does not currently contain `pnpm-lock.yaml` or `python/uv.lock`; until both are generated and committed, the project is development-only and not release-ready.

CI may remain less strict during bootstrap, but release workflows must use frozen dependency resolution.

## Import threat model

Teldra treats all project/import files as untrusted input, including `.teldra`, `.sh3d`, IFC, glTF/GLB, textures, and referenced assets.

Archive readers must reject absolute paths, parent traversal, symlinks, excessive entry counts, excessive decompressed size, and pathological compression ratios. Nested archives are not recursively expanded by default.

XML import disables external entities and network resolution. glTF/network assets do not gain ambient network access merely because a URI appears in imported content.

Parsers should prefer bounded streaming/iterative processing over loading arbitrarily large payloads into memory.

## Secrets

Authentication material is never canonical project data.

Home Assistant access tokens, OAuth refresh tokens, passwords, private keys, and equivalent secrets must not be serialized into `.teldra`, IFC properties, scene manifests, browser exports, fixtures, telemetry, or logs.

Project files may store stable non-secret connection references. Secret material belongs in host/platform secure storage and is resolved at runtime.

## Licensing boundary

The portable Teldra core is intended to use a permissive Apache-2.0 license, but that grant requires explicit repository-owner approval and complete license files before the first public release.

The Blender extension is a separate license zone targeting GPL-3.0-or-later, consistent with Blender Extensions requirements.

IfcOpenShell reusable libraries are LGPL-3.0-or-later; Bonsai is GPL-3.0-or-later. Teldra should depend on IfcOpenShell through its public library APIs and keep Bonsai/Blender-specific code inside the GPL integration boundary.

Sweet Home 3D and SweetHome3DJS are GPL-2-or-later. Teldra's SH3D support therefore remains a clean-room format-compatibility implementation based on independently observed/documented file semantics and Teldra-owned fixtures. GPL Sweet Home implementation code must not be copied into the portable core.

Third-party models, textures, HDRIs, fonts, sample projects, and other assets require explicit provenance and license metadata. A project's ability to import an asset does not imply Teldra may redistribute that asset.

## Distribution evidence

Every release must produce:

- SHA-256 checksums;
- CI provenance/attestation tying artifacts to source;
- an SBOM;
- dependency/license inventory;
- schema/project-format compatibility report;
- test and quality-budget report.

Native installers additionally require the appropriate platform signing/notarization before being described as production releases.

## Security fixes

Security-sensitive fixes should minimize disclosure of exploit details before a patched release is available. Public reporting instructions live in `SECURITY.md`.
