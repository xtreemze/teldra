# Reproducible dependency installs

Teldra records the exact JavaScript and Python dependency resolution in
`pnpm-lock.yaml` and `python/uv.lock`. Both are reviewed source artifacts,
not disposable generated files. Versions of the package managers, runtimes and
the IFC toolchain are pinned in `toolchain/manifest.json`, `package.json`
and `python/uv.toml`.

## Clean checkout

Use Node.js 24, pnpm 12.8.1, Python 3.12 and uv 0.12.19:

```sh
pnpm install --frozen-lockfile
cd python
uv sync --locked --group dev
uv run --locked pytest
```

A mismatch between an edited manifest and the committed lock must fail; do
not replace these commands with unlocked installs in CI. Development and
release policy checks reject missing lockfiles. Release certification still
requires its separate browser, security, licensing and artifact gates.

## Intentional refresh

1. Edit the source dependency declarations, using the pinned toolchain.
2. From the root, run `pnpm install --lockfile-only` when JS dependencies
   change; from `python/`, run `uv lock` when Python dependencies change.
3. Review the full lockfile diff, including transitive version changes,
   platform wheels, integrity hashes and license/security implications.
4. Verify the clean checkout commands above, then execute the relevant
   TypeScript, Python, Storybook and project-format tests.
5. Commit the manifest and lockfile updates together. Confirm the exact
   PR head passes CI before merge.

Do not hand-edit resolved package hashes or use network-dependent fresh
resolution during production builds. Keep the reviewed `pnpm-workspace.yaml`
`allowBuilds` policy intact.
