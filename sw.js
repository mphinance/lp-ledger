/* TT Tracker service worker — app-shell + Tesseract WASM/traineddata cache.
   Scoped to /mphinance/tt-tracker/ (registered with scope "./").
   First load fetches Tesseract.js + eng.traineddata (~12MB); they are then
   cached so OCR works fully offline afterward. */

const VERSION = "tt-tracker-v5";
const SHELL = "shell-" + VERSION;
const RUNTIME = "runtime-" + VERSION;

// Relative to the SW scope, so the /mphinance/ subpath is handled automatically.
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/app.css",
  "./js/app.js",
  "./js/engine.js",
  "./js/charts.js",
  "./js/ocr.js",
  "./js/seed.js",
  "./js/store.js",
  "./js/brand.js",
  "./js/validators.js",
  "./js/review.js",
  "./js/card.js",
  "./js/backup.js",
  "./js/vision.js",
  "./js/csv.js",
  "./assets/lp-logo.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/favicon-32.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Tesseract.js core/wasm/lang + Google Fonts: cache-first (big, immutable).
  const isHeavyCdn =
    /cdn\.jsdelivr\.net|unpkg\.com|tessdata|fonts\.gstatic\.com|fonts\.googleapis\.com/.test(url.href) ||
    /\.(wasm|traineddata|traineddata\.gz)$/.test(url.pathname);

  if (isHeavyCdn) {
    e.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  // Same-origin app shell: stale-while-revalidate.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
