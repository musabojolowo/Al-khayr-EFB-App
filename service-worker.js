/* =========================================================================
   service-worker.js — Al-Khayr EFB Tournament (Phase 8: PWA)
   ------------------------------------------------------------------------
   Strategy:
   - App shell (HTML/CSS/JS/icons/manifest) → cache-first, so the app opens
     instantly and works offline, with the cache refreshed in the
     background on every successful fetch (stale-while-revalidate).
   - Cross-origin static assets (Google Fonts, the Firebase SDK bundles)
     → cache-first too, since they're versioned/immutable URLs.
   - Firebase Realtime Database traffic → NEVER cached, always network.
     Realtime Database mostly talks over WebSockets anyway (invisible to
     a service worker), but its HTTPS long-polling fallback must still
     always hit the network so tournament data is never served stale.
   - Navigation requests that fail offline (no cache, no network) fall
     back to the cached index.html so the app shell still loads and shows
     its own "offline" banner rather than the browser's default error page.
   ========================================================================= */

const CACHE_VERSION = "alkhayr-efb-v2";
const APP_SHELL_CACHE = `app-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;

// Same-origin files precached on install. Keep this list in sync with the
// project's actual files — a missing/renamed file here fails the whole
// install step, so double-check after adding new JS files.
const APP_SHELL_FILES = [
  "./",
  "./index.html",
  "./admin.html",
  "./manifest.json",
  "./style.css",
  "./firebase.js",
  "./script.js",
  "./admin.js",
  "./assets/icons/logo-192.png",
"./assets/icons/logo-512.png",
"./favicon.ico"
];

// Any request whose URL contains one of these is realtime data — never cache.
const NEVER_CACHE_PATTERNS = [
  "firebaseio.com",
  "firebasedatabase.app",
  "identitytoolkit.googleapis.com",   // Firebase Auth calls
  "securetoken.googleapis.com"
];

function isNeverCache(url) {
  return NEVER_CACHE_PATTERNS.some((p) => url.includes(p));
}

/* ---------------------------------------------------------------------
   Install — precache the app shell. Old service workers keep running
   until all their tabs close, so this new one waits to activate until
   then unless the page explicitly asks it to skip waiting (see below).
   --------------------------------------------------------------------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL_FILES))
      .catch((err) => console.warn("[SW] Precache failed:", err))
  );
});

/* ---------------------------------------------------------------------
   Activate — drop any caches from a previous version.
   --------------------------------------------------------------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== APP_SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Lets a page force an already-downloaded update to take over immediately
// (used by the "Update available" flow in script.js / admin.js).
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/* ---------------------------------------------------------------------
   Fetch — the actual caching strategy.
   --------------------------------------------------------------------- */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept writes

  if (isNeverCache(request.url)) {
    return; // let the browser handle Firebase traffic natively
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((networkResponse) => {
          // Only cache good, basic/opaque responses (skip error pages)
          if (networkResponse && (networkResponse.ok || networkResponse.type === "opaque")) {
            const copy = networkResponse.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
        })
        .catch(() => {
          // Offline and not cached: for page navigations, fall back to the
          // cached app shell so the site still opens instead of erroring.
          if (request.mode === "navigate") {
            return caches.match("./index.html");
          }
          return cached; // may be undefined — that's fine, request just fails
        });

      // Stale-while-revalidate: serve the cache instantly if we have it,
      // and let the network request update the cache quietly in the background.
      return cached || networkFetch;
    })
  );
});
