/* DSR Trip Mapper - network-first app shell; libraries and map tiles cache-first so maps already seen work
   offline. Only ever deletes its OWN old caches: every DSR app shares the github.io origin's cache storage. */
var CACHE = 'dsr-tripmap-v1a';
var OWN = 'dsr-tripmap-';
var SHELL = ['./', './index.html', './app.js?v=1a', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return k.indexOf(OWN) === 0 && k !== CACHE && k !== OWN + 'tiles'; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.hostname.indexOf('nominatim') >= 0) return;   // place names: always live (the app caches them itself)
  if (url.hostname === 'tile.openstreetmap.org' || url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(caches.open(OWN + 'tiles').then(function (c) { return c.match(req).then(function (hit) { return hit || fetch(req).then(function (res) { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }); }); }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(req).then(function (res) { if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); } return res; }).catch(function () { return caches.match(req, { ignoreSearch: false }).then(function (r) { return r || caches.match('./index.html'); }); }));
});
