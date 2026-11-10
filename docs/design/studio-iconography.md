# Teldra iconography system

Status: implemented as a shared SolidJS decorative icon primitive and a Storybook catalog.

## Visual grammar

- Every functional icon uses a 24 × 24 vector coordinate space with a consistent 1.8 unit outline stroke, rounded caps and joins, and no fill.
- Icons inherit `currentColor`; state and semantic meaning are owned by the control, not independently hardcoded into the glyph. Destructive/warning colors are reserved for the parent action state.
- The default rendered size is 20 CSS pixels. Scale to 16, 24, 32, or 48 pixels without changing stroke semantics. A 44 CSS pixel interactive touch target is distinct from glyph size.
- Prefer recognizable architectural and BIM terminology: floor, room, wall, furniture, selection, move, rotate, scale, measure, and view. Rotation and scale glyphs express the available intent, not a promise that any arbitrary IFC geometry can be edited.
- Icon-only buttons must have an accessible name (`aria-label` or equivalent) and visible focus. When paired with a text label, the SVG remains `aria-hidden="true"`; never use icon shape as the only status indicator.
- Do not substitute Unicode/emoji symbols or mix competing outline weights in the same control group. The XYZ orientation gizmo is a data visualization and remains outside the icon grammar.
- In high-DPI environments, draw vectors directly in the DOM instead of upscaled raster buttons.

## Source and maintenance

The single source of truth for functional Studio icons is `apps/studio/src/StudioIcon.tsx`, which exports `StudioIcon`, `studioIconNames`, and `studioIconGroups`. `StudioIcon.css` handles optical alignment and conservative spacing; all glyph geometry is self-contained and requires no remote assets or icon packages.

`StudioIcon.stories.tsx` presents every icon grouped by domain and shows size variants. `StudioIcon.test.ts` ensures that the complete registered collection is categorized exactly once and contains nonempty path data. The production Playwright test `iconography.spec.ts` guards accessible names, stroke consistency, icon visibility and narrow-screen overflow.

The PWA launcher icon is intentionally **not** a functional toolbar icon: it is a distinct filled architectural-twin identity mark with a larger optical footprint, maskable safe area, and PNG raster derivatives. Its source and raster generation remain in `tools/site/generate-pwa-icons.mjs`. The landing site's favicon and navigation now use the same architectural symbol. Do not change the launcher mark when adding an action glyph.

## Required variants and future extensions

When adding icons, register a path in the one shared registry and assign exactly one catalog group. Keep non-display semantics in the invoking control: disabled, pending, selected, focused, and error states must remain accessible without color dependence. Add a Storybook example for genuinely different functional states rather than creating a second silhouette.

Screenshots of installed Android/iOS launchers and real-device rasterization remain covered by PWA certification issue #94; automatic SVG/Storybook tests are not substitutes for those checks.
