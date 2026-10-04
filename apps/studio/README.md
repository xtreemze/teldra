# Teldra Studio

Teldra Studio is the primary SolidJS browser application for authoring, exploring, and operating a smart-home digital twin.

SolidJS is a presentation boundary only. Domain, application, projection, Babylon.js, and deck.gl packages remain framework-neutral.

## Run the application

```bash
pnpm --filter @teldra/studio dev
pnpm --filter @teldra/studio build
```

The browser application opens user-selected `.teldra` files locally through the File System Access API. The project is validated before editing. Canonical twin edits flow through the application command processor and the project persistence contract; browser file handles, locks, IndexedDB recovery data, selection, and UI state are host/session state rather than portable project authority.

Writable local-file editing currently requires a Chromium-based browser with File System Access support. Unsupported browsers receive an explicit non-destructive message instead of silently uploading or rewriting a project through a different path.

## Component workbench

```bash
pnpm --filter @teldra/studio storybook
pnpm --filter @teldra/studio storybook:build
pnpm --filter @teldra/studio storybook:test
```

Stories are development specifications. Playwright runs against the built Storybook in Chromium and axe verifies accessibility for representative interactive states.
