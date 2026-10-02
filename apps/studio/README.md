# Teldra Studio

Teldra Studio is the primary SolidJS browser application for authoring, exploring, and operating a smart-home digital twin.

SolidJS is a presentation boundary only. Domain, application, projection, Babylon.js, and deck.gl packages remain framework-neutral.

## Component workbench

```bash
pnpm --filter @teldra/studio storybook
pnpm --filter @teldra/studio storybook:build
pnpm --filter @teldra/studio storybook:test
```

Stories are development specifications. Playwright runs against the built Storybook in Chromium and axe verifies accessibility for representative interactive states.
