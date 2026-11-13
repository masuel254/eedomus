// Service worker : réseau d'abord (toujours la dernière version), cache en secours hors ligne.
// Les appels à la maison (n8n) ne passent jamais par le cache.
var V = 'maison-2.9.4';
var SHELL = ['./', './index.html', './app.css', './app.js', './config.json', './changelog.json', './manifest.webmanifest', './icons/icon-192-v2.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(V).then(function (c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== V; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(function (r) {
    var copy = r.clone();
    caches.open(V).then(function (c) { c.put(e.request, copy); });
    return r;
  }).catch(function () { return caches.match(e.request); }));
});

// ---------- Notifications ----------
// La notification arrive vide (rien n'est chiffré) : on va chercher son texte auprès de la maison.
function setBadge(n) {
  try { if (n === 0 && self.navigator.clearAppBadge) return self.navigator.clearAppBadge(); if (n > 0 && self.navigator.setAppBadge) return self.navigator.setAppBadge(n); } catch (e) {}
  return Promise.resolve();
}
self.addEventListener('push', function (e) {
  e.waitUntil(Promise.all([fetch('./config.json').then(function (r) { return r.json(); }), self.registration.pushManager.getSubscription()]).then(function (x) {
    return fetch(x[0].api, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'push.pending', endpoint: x[1] && x[1].endpoint }) }).then(function (r) { return r.json(); });
  }).catch(function () { return null; }).then(function (j) {
    var items = j && j.items && j.items.length ? j.items : [{ title: 'Maison', body: 'Nouvelle alerte : ouvre l’appli', tag: 'maison' }];
    return Promise.all(items.map(function (it) {
      return self.registration.showNotification(it.title, { body: it.body, tag: it.tag || 'maison', icon: './icons/icon-192-v2.png', data: { tag: it.tag } });
    }).concat(items.filter(function (it) { return it.badge != null; }).slice(-1).map(function (it) { return setBadge(it.badge); })));
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var tg = e.notification.data && e.notification.data.tag;
  var url = tg === 'garage' ? './#logs=doors' : /^water/.test(tg || '') ? './#water' : './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    if (cs.length) { cs[0].postMessage({ open: url }); return cs[0].focus(); }
    return self.clients.openWindow(url);
  }));
});
