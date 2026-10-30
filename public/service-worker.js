/**
 * Service worker for the HCS ERP.
 *
 * Served from the site root so its scope is "/". Registering it from /resources/js/
 * (as this app did previously) scopes it to /resources/js/, where it can never
 * intercept a real page.
 *
 * Caching policy, and why it is deliberately narrow:
 *
 *   - Static assets (CSS, JS, vendored libraries, images) are cached. They are
 *     identical for every user and safe to keep. Code (CSS, JS, vendored
 *     libraries) is network-first, so the first page load after a deploy runs the
 *     new code; the cached copy is only for when the network is down. The server
 *     answers max-age=0 with an ETag, so an unchanged file costs a 304. Images
 *     are served from the cache and refreshed in the background.
 *   - Page HTML is NEVER cached. This is an ERP holding payroll, HR and CIS data,
 *     and site devices are shared. Caching rendered pages would let the next person
 *     to pick up the tablet page back through the previous user's data offline,
 *     after logout. Navigations are network-only with a static offline fallback.
 *   - API/JSON responses are never cached, for the same reason plus staleness.
 *
 * The previous implementation was cache-first across *every* request with no
 * versioning and no cleanup, which would have pinned staff to a permanently stale
 * dashboard with no way to clear it.
 */

// Bump when the precache list or caching rules change; the activate handler deletes
// every cache that does not match.
const VERSION = 'v3';
const STATIC_CACHE = `hcs-static-${VERSION}`;
const OFFLINE_URL = '/offline.html';
// The offline page embeds this logo. It must be precached alongside the page: it is
// otherwise only cached opportunistically, and the layout references it just as an
// apple-touch-icon, which most browsers never request — so an offline device could
// render the fallback page with a broken image.
const OFFLINE_LOGO = '/resources/images/HCS-Logo-v5-Icon192.png';

// Kept minimal on purpose: anything listed here that 404s aborts the whole install.
const PRECACHE = [OFFLINE_URL, OFFLINE_LOGO];

// Prefixes whose responses are safe to cache (same for all users, no personal data).
const STATIC_PREFIXES = [
  '/resources/css/',
  '/resources/js/',
  '/resources/vendor/',
  '/resources/images/',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

// Code changes with every deploy, so it's fetched first and the cache is the fallback
const CODE_PREFIXES = [
  '/resources/css/',
  '/resources/js/',
  '/resources/vendor/',
];

function isStaticAsset(url) {
  return STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

function isCode(url) {
  return CODE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

// Only persist a direct, successful, same-origin hit. `redirected` is the
// important one: an asset behind authentication redirects to the login page,
// which answers 200 with HTML — caching that would pin the login page under
// a .js or .css URL and break the app for the rest of the cache's life.
function keep(cache, request, response) {
  if (response && response.ok && !response.redirected && response.type === 'basic') {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch non-GET (mutations, CSRF-protected posts) or cross-origin requests.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: straight to the network, with a static offline page if it fails.
  // No page HTML is stored.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL)),
    );
    return;
  }

  // Code: the network first, so a deploy takes effect on the next load; the cache
  // only when offline. Serving the cached copy first ran the previous release's
  // scripts on the first load after every deploy.
  if (isCode(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then((cache) => fetch(request)
        .then((response) => keep(cache, request, response))
        .catch(async () => (await cache.match(request)) || Response.error())),
    );
    return;
  }

  // Images: serve from cache, revalidate in the background.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => keep(cache, request, response))
          .catch(() => cached);
        return cached || network;
      }),
    );
    return;
  }

  // Everything else (API, JSON, downloads): network only.
});
