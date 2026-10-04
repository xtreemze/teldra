# Teldra site

Static landing and onboarding site for Teldra, built with Astro (and its Vite toolchain).

## Development

```bash
pnpm --filter @teldra/site dev
pnpm --filter @teldra/site typecheck
pnpm --filter @teldra/site verify
```

`verify` performs a production build and checks that the landing page, onboarding route, favicon, canonical metadata, and GitHub Pages `/teldra/` base paths are present.

The production build uses the `/teldra` base path for GitHub Pages at `https://xtreemze.github.io/teldra/`.
