// Service worker for the GYM Ledger app shell.
//
// Two rules, and the second one is the important one:
//
//   1. The shell — the files that make the app exist — is cache-first, so the app opens
//      and runs in a basement gym with no signal.
//   2. Everything that is not this origin is never touched. api.github.com carries body
//      weight, waist, sleep and resting heart rate under an Authorization header, and a
//      cached copy of one of those responses on a shared device is exactly the leak the
//      rest of this design exists to avoid. Those requests are not intercepted at all:
//      no cache lookup, no cache write, no stale answer that could be mistaken for the
//      ledger's current state.
//
// Nothing is added to the cache at runtime. The cache holds precisely the list below,
// so it cannot accumulate a response nobody chose to store.

// The cache is keyed by the contents of the shell. Cache-first means a phone keeps
// serving whatever it installed, so a deployed fix that did not change this string would
// never reach him — he would be running an old client against a newer queue contract and
// have no way to tell. webapp/test.mjs recomputes this from the files and fails until it
// matches, and changing it here is also what makes the browser install the new worker.
const SHELL_REVISION = "01c0a871e4f823bd";
const CACHE = `gym-ledger-shell-${SHELL_REVISION}`;

const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./crypto.js",
  "./guard.js",
  "./queue.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./fonts/archivo.woff2",
  "./fonts/ibm-plex-sans.woff2",
  "./fonts/ibm-plex-mono.woff2",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One at a time: addAll rejects the whole install if a single file 404s, which would
    // leave the phone with no shell at all rather than with most of one.
    await Promise.all(SHELL.map(url => cache.add(new Request(url, {cache: "reload"})).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Not ours: hand it back to the network untouched. This is what keeps every
  // authenticated GitHub response out of storage.
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(request, {ignoreSearch: true});
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch (error) {
      // A navigation offline for a file that is not in the shell still gets the app,
      // rather than the browser's dinosaur.
      const fallback = await caches.match("./index.html");
      if (request.mode === "navigate" && fallback) return fallback;
      throw error;
    }
  })());
});
