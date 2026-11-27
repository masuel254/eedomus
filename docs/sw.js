// Service worker : réseau d'abord (toujours la dernière version), cache en secours hors ligne.
// Les appels à la maison (n8n) ne passent jamais par le cache.
var V = 'maison-2.71.9';
// Les notifications reçues sont gardées à part (30 dernières) : une mise à jour de l'appli ne les efface pas
var NOTIFS = 'maison-notifs';
var SHELL = ['./', './index.html', './app.css', './app.js', './config.json', './changelog.json', './manifest.webmanifest', './icons/icon-192-v2.png'];

self.addEventListener('install', function (e) {
  // cache: 'reload' : on ignore la copie gardée par le navigateur, sinon une nouvelle version peut s'installer avec l'ancien app.js
  e.waitUntil(caches.open(V).then(function (c) { return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); })); }));
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== V && k !== NOTIFS; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // cache: 'no-cache' : le navigateur redemande toujours au serveur si le fichier a changé (réponse « inchangé » très légère sinon)
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(function (r) {
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
// Titre clair dès l'écran verrouillé : un symbole selon le type d'alerte
function clearTitle(it) {
  var t = String(it.title || 'Maison'), ic = { garage: '🚗', water: '💧', wateroff: '💧', meteo: '🌬️', boiler: '🔥', test: '🔔' }[it.tag];
  if (/^Maison$/.test(t) && it.tag !== 'test') t = 'Alerte de la maison';
  return ic && t.indexOf(ic) !== 0 ? ic + ' ' + t : t;
}
// Historique : les 30 dernières notifications, gardées sur l'iPhone
function saveNotifs(items) {
  return caches.open(NOTIFS).then(function (c) {
    return c.match('./__notifs').then(function (r) { return r ? r.json() : []; }).catch(function () { return []; }).then(function (list) {
      list = (list || []).concat(items.map(function (it) { return { at: it.at, title: it.title, body: it.body || '', tag: it.tag || 'maison', lost: !!it.lost }; })).slice(-30);
      return c.put('./__notifs', new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } }));
    });
  }).then(function () {
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) { cs.forEach(function (cl) { cl.postMessage({ notifs: true }); }); });
  }).catch(function () {});
}
// Mouchard : signale au serveur que la notification est bien arrivée ici (version, contenu lu, erreur éventuelle)
function pushSeen(info) {
  return Promise.all([fetch('./config.json').then(function (r) { return r.json(); }), self.registration.pushManager.getSubscription()]).then(function (x) {
    return fetch(x[0].api, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'push.pending', endpoint: x[1] && x[1].endpoint, seen: info, peek: true }) });
  }).catch(function () {});
}
self.addEventListener('push', function (e) {
  // Nouveau : le texte arrive chiffré DANS la notification (l'iPhone le déchiffre) ; on l'affiche directement
  var direct = null, perr = ''; try { direct = e.data ? e.data.json() : null; } catch (er) { direct = null; perr = String(er && er.message || er).slice(0, 80); }
  var seen = { v: V, data: !!e.data, parsed: !!direct, err: perr };
  if (direct && (direct.item || direct.notification)) {
    var n = direct.notification || {}, it = direct.item || { title: n.title, body: n.body, tag: n.tag };
    if (it.badge == null && n.app_badge != null) it.badge = +n.app_badge;
    it = Object.assign({}, it, { title: clearTitle(it), at: it.at || Date.now() });
    e.waitUntil(Promise.all([
      self.registration.showNotification(it.title, { body: it.body || '', tag: it.tag || 'maison', icon: './icons/icon-192-v2.png', data: { tag: it.tag } })
        .then(function () { seen.shown = true; }, function (er) { seen.err = 'affichage : ' + String(er && er.message || er).slice(0, 80); }),
      saveNotifs([it])
    ].concat(it.badge != null ? [setBadge(it.badge)] : [])).then(function () { return pushSeen(seen); }));
    return;
  }
  e.waitUntil(Promise.all([fetch('./config.json').then(function (r) { return r.json(); }), self.registration.pushManager.getSubscription()]).then(function (x) {
    return fetch(x[0].api, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'push.pending', endpoint: x[1] && x[1].endpoint, seen: seen }) }).then(function (r) { return r.json(); });
  }).catch(function () { return null; }).then(function (j) {
    var items = j && j.items && j.items.length ? j.items : [{ title: 'Alerte de la maison', body: 'Le détail n’a pas pu être lu. Touche pour voir l’état de la maison.', tag: 'notifs', lost: true }];
    items = items.map(function (it) { return Object.assign({}, it, { title: clearTitle(it), at: it.at || Date.now() }); });
    return Promise.all(items.map(function (it) {
      return self.registration.showNotification(it.title, { body: it.body, tag: it.tag || 'maison', icon: './icons/icon-192-v2.png', data: { tag: it.tag } });
    }).concat([saveNotifs(items)]).concat(items.filter(function (it) { return it.badge != null; }).slice(-1).map(function (it) { return setBadge(it.badge); })));
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var tg = e.notification.data && e.notification.data.tag;
  var url = tg === 'garage' ? './#logs=doors' : /^water/.test(tg || '') ? './#water' : tg === 'meteo' ? './#meteo' : tg === 'smoke' ? './#smoke' : tg === 'notifs' ? './#notifs' : './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    if (cs.length) { cs[0].postMessage({ open: url }); return cs[0].focus(); }
    return self.clients.openWindow(url);
  }));
});
