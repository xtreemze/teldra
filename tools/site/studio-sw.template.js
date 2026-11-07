/* Generated at build time: APP_CACHE and PRECACHE are prepended by generate-pwa-sw.mjs. */
const SCOPE = self.registration.scope;
const SHELL_URL = new URL("./index.html", SCOPE).href;
const SHELL_CACHE_PREFIX = "teldra-studio-shell-";
const DEMO_CACHE = "teldra-studio-demo-v1";
const scopedPath = new URL(SCOPE).pathname;
const precachedPaths = new Set(PRECACHE.map(path => new URL(path, SCOPE).pathname));

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(PRECACHE.map(path =>
      new Request(new URL(path, SCOPE), { cache: "reload" })));
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    // A waiting worker may activate while other windows still run older code.
    // Retain one preceding shell for lazy chunks requested by those windows.
    const names = (await caches.keys()).filter(name =>
      name.startsWith(SHELL_CACHE_PREFIX) && name !== APP_CACHE);
    const obsolete = names.slice(0, -1);
    await Promise.all(obsolete.map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

async function cachedAsset(request) {
  const current = await caches.open(APP_CACHE);
  const matching = await current.match(request, { ignoreSearch: true });
  if (matching) return matching;
  // CacheStorage.keys() order is insertion order; prefer the newest prior build.
  const previous = (await caches.keys()).filter(name =>
    name.startsWith(SHELL_CACHE_PREFIX) && name !== APP_CACHE).reverse();
  for (const name of previous) {
    const response = await (await caches.open(name)).match(request, { ignoreSearch: true });
    if (response) return response;
  }
  return fetch(request);
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scopedPath)) return;
  const relative = url.pathname.slice(scopedPath.length);

  if (relative === "demo.teldra" || relative === "21D.teldra") {
    event.respondWith((async () => {
      const cache = await caches.open(DEMO_CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.status === 200) {
          // Owner-authorized public examples are cached only after explicit access,
          // and quota failure must not interrupt the user's network response.
          event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
        }
        return response;
      } catch (error) {
        const saved = await cache.match(request);
        if (saved) return saved;
        throw error;
      }
    })());
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      // Do not mix newly deployed HTML with the previous worker's lazy chunks.
      // A new release becomes visible only after the user accepts the update.
      const cache = await caches.open(APP_CACHE);
      const shell = await cache.match(SHELL_URL);
      if (shell) return shell;
      try {
        return await fetch(request);
      } catch {
        return new Response("Teldra Studio needs an initial online installation.", {status: 503});
      }
    })());
    return;
  }

  // Current and preceding hashed lazy chunks must remain accessible while
  // older tabs are open. Never cache arbitrary files, API requests or projects.
  if (precachedPaths.has(url.pathname) || /^assets\/[^/][^?]*$/.test(relative)) {
    event.respondWith(cachedAsset(request));
  }
});
