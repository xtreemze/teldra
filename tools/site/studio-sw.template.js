/* Generated at build time: the version and manifest are prepended by generate-pwa-sw.mjs. */
const SCOPE = self.registration.scope;
const SHELL_URL = new URL("./index.html", SCOPE).href;
const DEMO_CACHE = "teldra-studio-demo-v1";

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(PRECACHE.map(path =>
      new Request(new URL(path, SCOPE), { cache: "reload" })));
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name =>
      name.startsWith("teldra-studio-shell-") && name !== APP_CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin ||
      !url.pathname.startsWith(new URL(SCOPE).pathname)) return;
  const relative = url.pathname.slice(new URL(SCOPE).pathname.length);
  if (relative === "demo.teldra" || relative === "21D.teldra") {
    event.respondWith((async () => {
      const cache = await caches.open(DEMO_CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.status === 200) {
          // Large homes are never part of the mandatory install payload.
          // Quota failure leaves network editing and local .teldra files intact.
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
      try {
        const response = await fetch(request);
        if (response.ok) return response;
        return response;
      } catch {
        return (await caches.match(SHELL_URL)) ??
          new Response("Teldra Studio needs an initial online installation.", {status:503});
      }
    })());
    return;
  }
  if (PRECACHE.some(path => new URL(path, SCOPE).pathname === url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      return (await cache.match(request, { ignoreSearch: true })) ?? fetch(request);
    })());
  }
});
