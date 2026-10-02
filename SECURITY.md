# Security policy

## Reporting

Do not publish suspected vulnerabilities, credentials, private project files, or exploit details in a public issue.

Use GitHub's private vulnerability reporting / security advisory workflow for this repository when available. If that channel is unavailable, contact the repository owner privately rather than opening a public issue.

Include the affected version/commit, minimal reproduction, impact, and whether untrusted project/import data is required. Remove real smart-home credentials and personal building data from reproductions.

## Supported releases

Until Teldra has its first tagged public release, only the current `main` branch is supported for security fixes.

Once releases begin, the supported-version window must be declared in release metadata before publication.

## Security boundaries

Treat the following as untrusted:

- `.teldra` archives;
- Sweet Home 3D `.sh3d` archives and `Home.xml`;
- IFC;
- glTF/GLB and referenced resources;
- images, textures, HDRIs, media, and metadata;
- Home Assistant and other adapter responses;
- filenames and paths contained in imported projects.

Import code must enforce the limits in `release/policy.json`.

## Secrets

Never commit or serialize real Home Assistant tokens, OAuth refresh tokens, passwords, private keys, cookies, or equivalent credentials.

Fixtures must contain synthetic identifiers only. Logs and diagnostics must redact credentials and authorization headers.

## Disclosure

After a fix is available, maintainers may publish a security advisory with affected versions, impact, remediation, and credit. Avoid publishing unnecessary exploit material that would increase risk to users who have not upgraded.
