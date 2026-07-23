// XAU Scalper Service Worker — enables PWA install + basic caching
const CACHE_NAME = "xau-scalper-v1";
const PRECACHE_URLS = ["/", "/index.html"];

// Install: pre-cache shell
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

// Fetch: network-first for API/data, cache-first for static assets
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Always go to network for API calls and Convex
  if (
    url.pathname.startsWith("/api") ||
    url.hostname.includes("convex") ||
    url.hostname.includes("binance")
  ) {
    return;
  }

  // For navigation requests (HTML), try network first
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/index.html")),
    );
    return;
  }

  // Static assets: stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetched = fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches
            .open(CACHE_NAME)
            .then(cache => cache.put(event.request, clone));
        }
        return response;
      });
      return cached || fetched;
    }),
  );
});
