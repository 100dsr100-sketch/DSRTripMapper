/* DSR Trip Mapper - network-first app shell; libraries and map tiles cache-first so maps already seen work
   offline. Only ever deletes its OWN old caches.
   2a: app files fetched with cache:'no-cache' (updates show on the next open); the tile cache keeps the newest ~3000
   tiles (it grew without limit); libraries (Leaflet, jsPDF) in their own cache. */
var CACHE = 'dsr-tripmap-v2a';
var OWN = 'dsr-tripmap-';
var TILES = OWN + 'tiles', LIBS = OWN + 'libs', TILE_MAX = 3000;
var SHELL = ['./', './index.html', './app.js?v=2a', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png', './dsr-move.js?v=2'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).catch(function () {}).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return k.indexOf(OWN) === 0 && k !== CACHE && k !== TILES && k !== LIBS; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
function trim(c) { return c.keys().then(function (ks) { return Promise.all(ks.slice(0, Math.max(0, ks.length - TILE_MAX)).map(function (k) { return c.delete(k); })); }); }
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.hostname.indexOf('nominatim') >= 0) return;   // place names: always live (the app caches them itself)
  var tile = url.hostname === 'tile.openstreetmap.org', lib = url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'cdnjs.cloudflare.com';
  if (tile || lib) {
    e.respondWith(caches.open(tile ? TILES : LIBS).then(function (c) { return c.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) { if (res.ok || res.type === 'opaque') c.put(req, res.clone()).then(function () { if (tile && Math.random() < 0.02) trim(c); }); return res; }); }); }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(req, { cache: 'no-cache' }).then(function (res) { if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); } return res; })
    .catch(function () { return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || caches.match('./index.html'); }); }));
});
