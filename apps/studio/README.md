# Teldra Studio

Teldra Studio is the primary SolidJS browser application for authoring, exploring, and operating a smart-home digital twin.

SolidJS is a presentation boundary only. Domain, application, projection, Babylon.js, and deck.gl packages remain framework-neutral.

## Local project workflow

The production browser shell opens a local `.teldra` file through the File System Access API, validates the project/archive contracts, edits canonical twin state through `StudioProjectController`, and saves through the project-format persistence boundary.

```bash
pnpm --filter @teldra/studio dev
pnpm --filter @teldra/studio build
```

Direct local writeback requires a Chromium-based browser with File System Access support. Unsupported browsers receive a non-destructive fallback rather than silently copying project state into browser storage.

## Component workbench

```bash
pnpm --filter @teldra/studio storybook
pnpm --filter @teldra/studio storybook:build
pnpm --filter @teldra/studio storybook:test
```

Stories are development specifications. Playwright runs against the built Storybook in Chromium and axe verifies accessibility for representative interactive states.
