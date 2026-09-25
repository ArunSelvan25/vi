/**
 * Service worker — what makes this installable and quick to open on a phone.
 *
 * Two rules keep it out of trouble:
 *
 *  1. Only same-origin GETs are ever served from the cache. Every call to the
 *     API is a cross-origin POST, so live data is never cached,
 *     never replayed, and never served stale. Sign-in tokens and tenant records
 *     stay out of the cache entirely.
 *
 *  2. The cache name carries a build id, rewritten at deploy time by
 *     scripts/stamp-build.mjs. A release changes it, the new worker fetches the
 *     whole shell afresh into a new cache and deletes the old one — so an
 *     update can never leave a browser running half the old files and half the
 *     new ones.
 *
 * The worker never takes over from the version already running: a waiting
 * update is offered to the user by assets/js/pwa.js and applied only when they
 * accept, so the code cannot change underneath a half-filled form.
 */

/** Rewritten on deploy. Any change to this line ships a new cache. */
const BUILD = 'dev';

const CACHE = 'vipm-shell-' + BUILD;

/**
 * Everything needed to open the app with no network.
 *
 * app.js imports every view at load, so this is the complete set — there are no
 * lazily loaded chunks that could arrive from a different build. test/pwa-test
 * .mjs checks the list against what is actually on disk.
 */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/styles.css',
  './assets/js/api.js',
  './assets/js/app.js',
  './assets/js/config.js',
  './assets/js/pwa.js',
  './assets/js/router.js',
  './assets/js/schema.js',
  './assets/js/store.js',
  './assets/js/ui.js',
  './assets/js/components/charts.js',
  './assets/js/components/detail.js',
  './assets/js/components/form.js',
  './assets/js/components/hovercard.js',
  './assets/js/components/occupants.js',
  './assets/js/components/search.js',
  './assets/js/components/table.js',
  './assets/js/views/adders.js',
  './assets/js/views/billing.js',
  './assets/js/views/crud.js',
  './assets/js/views/dashboard.js',
  './assets/js/views/details.js',
  './assets/js/views/invoices.js',
  './assets/js/views/leases.js',
  './assets/js/views/onboarding.js',
  './assets/js/views/records.js',
  './assets/js/views/rentrun.js',
  './assets/js/views/reports.js',
  './assets/js/views/settings.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  // addAll is all-or-nothing on purpose: a shell missing one module is worse
  // than no offline support, because it fails only once the user is offline.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('vipm-shell-') && n !== CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/** The page asks for this once the user accepts an update. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Every API call is a POST, so this alone keeps the API out of the cache.
  if (req.method !== 'GET') return;

  // ...and this keeps out anything else that is not ours, whatever its method.
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // A launch, a deep link and a reload all have to land on the app shell —
  // including with no network, which is the whole point of installing it.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const shell = await caches.match('./index.html', { ignoreSearch: true });
      if (shell) return shell;
      try { return await fetch(req); }
      catch (e) { return new Response('Offline', { status: 503, statusText: 'Offline' }); }
    })());
    return;
  }

  event.respondWith(cacheFirst(req));
});

/**
 * Cache first, because within one build the files never change — the build id
 * in the cache name is what changes. Anything not precached (a file added
 * without updating SHELL) still works: it is fetched, used, and kept for next
 * time.
 */
async function cacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;

  const res = await fetch(req);
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
  }
  return res;
}
