# Studio progressive web app delivery

Status: installable app shell implemented; platform certification remains an explicit release gate.

## Deployment and capabilities

The installed application uses the existing SolidJS Studio at
`https://xtreemze.github.io/teldra/studio/`. It does not duplicate or replace the
domain, IFC writer, project archive, Babylon rendering, or Home Assistant adapter.
The web manifest is deliberately relative to the Studio path (`./` for ID, scope,
and start URL) so that installed launches do not go to the root Astro site.

Generated icon sources and raster variants are maintained by
`tools/site/generate-pwa-icons.mjs` using Node built-ins. The asset family includes
a scalable favicon, install icon, 192/512 PNGs, a 512 maskable icon, and an Apple
touch icon. Icons represent the architecture/digital-twin domain; source home
textures, reference photos, and other proprietary artwork are not rebranded or
embedded into promotional assets.

The installed Studio retains existing spatial navigation, multi-touch gestures,
IFC-aware move/rotate drafts, twin editing, undo/redo, local file opening, and
project save/export semantics. The PWA does not relax the IFC authoring contract
or add an uncommittable scale gizmo.

On Chromium desktop systems supporting PWA file handling, opening a `.teldra`
file through the OS launches `?launch=file` and passes the file to the existing
project controller. A running unsaved project requires confirmation before a
different project replaces it. On other browsers, the existing file picker and
download-save fallback remain available.

## Offline and update policy

The versioned service worker precaches Studio HTML, the manifest/icons, and all
built JavaScript, CSS, WASM, and small derived renderer image/font assets. This
covers the editor and its lazy-loaded IFC/WASM dependencies. The 53.4 MiB complete
21D home is deliberately excluded from mandatory installation, preserving
first-install storage and bandwidth. Both the complete demo and the small sample
are network-first and can be reused offline **after a successful controlled
download** if CacheStorage quota permits. A failed cache write must not interrupt
the interactive network response. Local `.teldra` documents stay user-owned and
are never copied to the public application cache.

Service worker cache names change with build content, keeping upgrades atomic.
The old worker continues serving an open editing session until the user chooses
**Update**. When a canonical project has unsaved changes, the update action
requires saving or discarding them before reload. The service worker does not
intercept Home Assistant traffic, cross-origin requests, non-GET operations,
range requests, or local blob URLs.

Offline means cached app code and already available project data; it does **not**
mean live Home Assistant status/commands, account sign-in, cloud sources, or a
not-yet-downloaded 21D demo can function without network access. Mobile OS
storage eviction and PWA file-handler support vary by browser and are not
represented as universally guaranteed.

## Verification and release

Build with `pnpm pages:build`; this generates icons and the hashed service
worker, assembles the exact GitHub Pages tree, and verifies every precached path.
Run `pnpm --filter @teldra/studio pages:test` for Chromium production-scope
manifest/offline navigation, sample-project loading and viewport tests.

Release certification still requires install/launch, file import/export, offline
reload, storage quota/eviction, and update-with-unsaved-changes testing on
Android Chrome, iOS/iPadOS Safari, desktop Chromium and Safari. Home Assistant
operations require online integration testing. Do not claim offline availability
for a user project unless its document is accessible locally on that device.
