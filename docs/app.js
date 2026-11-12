/* Maison — appli de pilotage eedomus (PWA).
   Le jeton d'accès n'est jamais dans le code : il est déposé une fois sur le téléphone
   via le lien d'installation (#k=...) et gardé dans le stockage local de l'iPhone. */
(function () {
  'use strict';

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  var m = location.hash.match(/k=([A-Za-z0-9_-]{16,})/);
  if (m) {
    store.set('maison.token', m[1]);
    var nm = location.hash.match(/n=([^&]+)/); if (nm) store.set('maison.name', decodeURIComponent(nm[1]));
    history.replaceState(null, '', location.pathname);
  }
  var userName = store.get('maison.name') || '';

  var token = store.get('maison.token');
  var CFG = null, STATES = {}, lastOk = 0, offline = false;
  var openRoom = store.get('maison.open') || 'salon';
  var pending = {};            // id -> { value, until } : affichage immédiat avant confirmation
  var app = document.getElementById('app');
  var dock = document.getElementById('dock');
  var toastEl = document.getElementById('toast'), toastT;

  // ---------- Outils ----------
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function icon(n) { return '<svg class="i"><use href="#' + n + '"/></svg>'; }
  function val(id) {
    var p = pending[id];
    if (p && p.until > Date.now()) return String(p.value);
    var s = STATES[id]; return s ? String(s.value) : undefined;
  }
  function num(id) { var v = parseFloat(val(id)); return isNaN(v) ? null : v; }
  function fmt(n, d) { return n == null ? '—' : n.toFixed(d == null ? 1 : d).replace('.', ','); }
  function toast(msg, err) {
    toastEl.textContent = msg; toastEl.className = 'toast' + (err ? ' err' : ''); toastEl.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }
  function ago(t) {
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 10) return "à l'instant"; if (s < 60) return 'il y a ' + s + ' s';
    return 'il y a ' + Math.round(s / 60) + ' min';
  }

  // ---------- API (n8n) ----------
  function api(body) {
    body.token = token;
    return fetch(CFG.api, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j.ok) { var e = new Error(j.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
          return j;
        });
      });
  }
  var refreshing = false;
  function refresh() {
    if (refreshing || !token) return; refreshing = true;
    api({ action: 'state' }).then(function (j) {
      STATES = j.states; lastOk = Date.now(); offline = false; if (!document.querySelector('.confirming, .armed-confirm')) render();
    }).catch(function (e) {
      if (e.status === 401) { token = null; return setup(); }
      offline = true; render();
    }).then(function () { refreshing = false; });
  }
  function send(id, value, opts) {
    opts = opts || {};
    if (opts.optimistic !== false) pending[id] = { value: value, until: Date.now() + 8000 };
    render();
    return api({ action: 'set', id: id, value: value }).then(function () {
      if (opts.msg) toast(opts.msg);
      setTimeout(refresh, 1500); setTimeout(refresh, 6000);
    }).catch(function (e) {
      delete pending[id]; render();
      toast(e.status === 403 ? 'Action non autorisée' : 'La maison ne répond pas, réessaie', true);
    });
  }

  // ---------- État dérivé ----------
  function isOn(it) { var v = val(it.id); if (v === undefined) return false; return it.on !== undefined && isNaN(+it.on) ? v === String(it.on) : parseFloat(v) > 0; }
  function shutterPos(id) { var v = num(id); if (v == null) return null; if (v === 240) return 'stop'; if (v >= 99) return 'up'; if (v <= 0) return 'down'; return 'part'; }
  function doorOpen(id) { var v = val(id); return v !== undefined && v !== '0'; }
  function alarmArmed() { var v = val(CFG.status.alarm); return v !== undefined && v !== '0'; }

  function marks(room) {
    var h = '', lights = [], sh = [], doors = [];
    room.items.forEach(function (it) {
      if (it.type === 'light' || it.type === 'switch') lights.push(it);
      if (it.type === 'shutter') sh.push(it);
      if (it.type === 'door') doors.push(it);
    });
    if (lights.length) {
      var on = lights.filter(isOn).length;
      h += on ? '<span class="mark l">' + icon('bulb') + on + ' allumé' + (on > 1 ? 's' : '') + '</span>' : '<span class="mark">' + icon('bulb') + 'Éteint</span>';
    }
    if (sh.length) {
      var up = sh.filter(function (i) { return shutterPos(i.id) === 'up'; }).length;
      var down = sh.filter(function (i) { return shutterPos(i.id) === 'down'; }).length;
      h += '<span class="mark v">' + icon('blind') + (up === sh.length ? 'Ouverts' : down === sh.length ? 'Fermés' : up + '/' + sh.length + ' ouverts') + '</span>';
    }
    if (doors.length) {
      var open = doors.filter(function (d) { return doorOpen(d.id); }).length;
      h += open ? '<span class="mark bad">' + icon('door') + 'Porte ouverte</span>' : '<span class="mark d">' + icon('door') + 'Fermée</span>';
    }
    return '<span class="marks">' + h + '</span>';
  }

  // ---------- Rendu ----------
  function rowHTML(it) {
    var id = it.id;
    if (it.type === 'light' || it.type === 'switch') {
      var on = isOn(it);
      return '<button class="row' + (on ? ' is-on' : '') + (pending[id] ? ' busy' : '') + '" data-light="' + id + '">' +
        '<span class="ic">' + icon(it.icon || 'bulb') + '</span><span><b>' + esc(it.name) + '</b><small>' + (on ? 'Allumé' : 'Éteint') + '</small></span><span class="sw"></span></button>';
    }
    if (it.type === 'shutter') {
      var p = shutterPos(id), n = num(id);
      var lbl = { up: 'Ouvert', down: 'Fermé', stop: 'Arrêté', part: 'Ouvert à ' + fmt(n, 0) + ' %' }[p] || '—';
      return '<div class="row"><span class="ic">' + icon('blind') + '</span><span><b>' + esc(it.name) + '</b><small>' + lbl + '</small></span><span class="tri">' +
        '<button data-shutter="' + id + '" data-v="100" class="' + (p === 'up' ? 'on' : '') + '" aria-label="Ouvrir">' + icon('up') + '</button>' +
        '<button data-shutter="' + id + '" data-v="240" class="' + (p === 'stop' ? 'on' : '') + '" aria-label="Stop">' + icon('stop') + '</button>' +
        '<button data-shutter="' + id + '" data-v="0" class="' + (p === 'down' ? 'on' : '') + '" aria-label="Fermer">' + icon('down') + '</button></span></div>';
    }
    if (it.type === 'door') {
      var o = doorOpen(id);
      return '<div class="row"><span class="ic">' + icon('door') + '</span><span><b>' + esc(it.name) + '</b><small>Contact de porte</small></span><span class="' + (o ? 'bad' : 'ok') + '">' + (o ? 'Ouverte' : 'Fermée') + '</span></div>';
    }
    if (it.type === 'garage') {
      var st = STATES[id] ? STATES[id].text : '';
      return '<div class="row"><span class="ic">' + icon('garage') + '</span><span><b>' + esc(it.name) + '</b><small>' + esc(st || '—') + '</small></span><span class="btns">' +
        '<button class="act" data-action="' + id + '" data-v="1" data-confirm data-msg="Garage : ouverture envoyée">Ouvrir</button>' +
        '<button class="act" data-action="' + id + '" data-v="2" data-confirm data-msg="Garage : fermeture envoyée">Fermer</button></span></div>';
    }
    if (it.type === 'action') {
      return '<div class="row"><span class="ic">' + icon(it.icon || 'home') + '</span><span><b>' + esc(it.name) + '</b><small>' + (STATES[id] ? esc(STATES[id].text) : '') + '</small></span>' +
        '<button class="act" data-action="' + id + '" data-v="' + esc(it.value) + '"' + (it.confirm ? ' data-confirm' : '') + ' data-msg="' + esc(it.name) + ' : envoyé">' + esc(it.label || 'OK') + '</button></div>';
    }
    if (it.type === 'sensor') {
      var x = num(id); if (x != null && it.scale) x = x * it.scale;
      return '<div class="row"><span class="ic">' + icon(it.icon || 'thermo') + '</span><span><b>' + esc(it.name) + '</b><small>' + (STATES[id] && STATES[id].changed ? 'Mesuré ' + esc(STATES[id].changed.slice(5, 16).replace(' ', ' à ').replace(/^(\d\d)-(\d\d)/, '$2/$1')) : '') + '</small></span>' +
        '<span class="val">' + fmt(x, it.decimals) + (x == null ? '' : esc(it.unit || '')) + '</span></div>';
    }
    return '';
  }

  function heroHTML() {
    var h = CFG.heating, t = num(h.roomTemp);
    var pct = t == null ? 0 : Math.max(0, Math.min(1, (t - 10) / 20));
    var arc = (pct * 377).toFixed(1);
    return '<section class="hero" aria-label="Chauffage">' +
      '<div class="hero-top"><span>Chauffage · ' + esc(h.room) + '</span><span class="badge soon">' + icon('flame') + 'Netatmo bientôt</span></div>' +
      '<div class="ring"><svg viewBox="0 0 190 190" aria-hidden="true">' +
      '<circle cx="95" cy="95" r="80" fill="none" stroke="#262B32" stroke-width="11" stroke-linecap="round" stroke-dasharray="377 503"/>' +
      '<circle cx="95" cy="95" r="80" fill="none" stroke="#FF8A5B" stroke-width="11" stroke-linecap="round" stroke-dasharray="' + arc + ' 503"/></svg>' +
      '<div class="v"><b>' + fmt(t, 1) + '°</b><small>Intérieur</small></div></div>' +
      '<div class="row3"><span><b>' + fmt(num(h.outside), 1) + '°</b>Dehors</span><span><b>' + fmt(num(h.humidity), 0) + ' %</b>Humidité</span><span><b>' + fmt(num(h.upstairs), 1) + '°</b>Étage</span></div>' +
      '</section>';
  }

  function chipsHTML() {
    var s = CFG.status;
    var openDoors = s.doors.filter(doorOpen).length;
    var armed = alarmArmed();
    var home = s.people.filter(function (id) { var v = val(id); return v !== undefined && v !== '0'; }).map(function (id) { return String((STATES[id] && STATES[id].text) || '').replace(/s+(pr[ée]sente?|absente?)$/i, ''); }).filter(Boolean);
    return '<div class="chips">' +
      '<span class="chip' + (openDoors ? ' bad' : '') + '"><span class="d"></span>' + (openDoors ? openDoors + ' porte' + (openDoors > 1 ? 's' : '') + ' ouverte' + (openDoors > 1 ? 's' : '') : 'Portes fermées') + '</span>' +
      '<button class="chip' + (armed ? ' armed' : '') + '" data-alarm data-confirm>' + icon('shield') + '<span>' + (armed ? 'Alarme activée' : 'Alarme désactivée') + '</span></button>' +
      '<span class="chip">' + icon(home.length ? 'home' : 'leave') + (home.length ? esc(home.join(', ')) + ' à la maison' : 'Personne à la maison') + '</span>' +
      '</div>';
  }

  function roomsHTML() {
    return CFG.groups.map(function (g) {
      return '<div class="sec-hd"><h2>' + esc(g.name) + '</h2></div><div class="acc">' + g.rooms.map(function (r) {
        var o = r.id === openRoom, t = r.temp ? num(r.temp) : null;
        return '<div class="acc-item' + (o ? ' open' : '') + '" id="room-' + r.id + '"><button class="acc-head" data-room="' + r.id + '" aria-expanded="' + o + '">' +
          '<span><b>' + esc(r.name) + '</b>' + marks(r) + '</span><span class="temp">' + (t == null ? '' : fmt(t, 1) + '°') + '</span><span class="chev">' + icon('down') + '</span></button>' +
          (o ? '<div class="acc-body">' + (r.camera ? '<div class="cam"><div>' + icon('cam') + '<br>Caméra Netatmo<br>branchement à venir</div></div>' : '') + r.items.map(rowHTML).join('') + '</div>' : '') +
          '</div>';
      }).join('') + '</div>';
    }).join('');
  }

  function render() {
    if (!CFG || !token) return;
    var d = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    app.innerHTML =
      '<header class="hd"><div><small>' + esc(d.charAt(0).toUpperCase() + d.slice(1)) + '</small><h1>Bonjour' + (userName ? ' ' + esc(userName) : '') + '</h1></div>' +
      '<div class="sync' + (offline ? ' off' : '') + '"><i></i>' + (offline ? 'Hors ligne' : lastOk ? ago(lastOk) : '…') + '</div></header>' +
      heroHTML() + chipsHTML() + roomsHTML() +
      '<div class="foot">Maison · eedomus' + (lastOk ? ' · mis à jour ' + ago(lastOk) : '') + '</div>';
    var armed = alarmArmed();
    dock.hidden = false;
    var da = dock.querySelector('[data-dock="alarm"]');
    if (!da.classList.contains('armed-confirm')) da.classList.toggle('armed', armed);
  }

  function setup() {
    dock.hidden = true;
    app.innerHTML = '<div class="setup"><h1>Maison</h1><p>Cette appli n\'est pas encore reliée à ta maison. Ouvre le lien d\'installation (QR code) depuis cet iPhone.</p></div>';
  }

  // ---------- Confirmation en deux temps (portail, garage, alarme) ----------
  function confirmed(btn) {
    if (!btn.hasAttribute('data-confirm')) return true;
    if (btn._armed) { clearTimeout(btn._armed); btn._armed = null; btn.classList.remove('confirming', 'armed-confirm'); return true; }
    var label = btn.querySelector('span') || btn, old = label.textContent;
    btn.classList.add(btn.closest('.dock') ? 'armed-confirm' : 'confirming');
    label.textContent = 'Confirmer ?';
    btn._armed = setTimeout(function () { btn._armed = null; btn.classList.remove('confirming', 'armed-confirm'); label.textContent = old; }, 3000);
    return false;
  }

  // ---------- Interactions ----------
  app.addEventListener('click', function (e) {
    var b;
    if ((b = e.target.closest('[data-room]'))) {
      openRoom = openRoom === b.dataset.room ? '' : b.dataset.room; store.set('maison.open', openRoom); return render();
    }
    if ((b = e.target.closest('[data-light]'))) {
      var it = findItem(+b.dataset.light), on = isOn(it);
      return send(it.id, on ? (it.off !== undefined ? it.off : 0) : (it.on !== undefined ? it.on : 100));
    }
    if ((b = e.target.closest('[data-shutter]'))) return send(+b.dataset.shutter, +b.dataset.v);
    if ((b = e.target.closest('[data-action]'))) {
      if (!confirmed(b)) return;
      return send(+b.dataset.action, b.dataset.v, { optimistic: false, msg: b.dataset.msg });
    }
    if ((b = e.target.closest('[data-alarm]'))) {
      if (!confirmed(b)) return;
      var armed = alarmArmed();
      return send(CFG.status.alarm, armed ? 0 : 12, { msg: armed ? 'Alarme désactivée' : 'Alarme activée' });
    }
  });
  dock.addEventListener('click', function (e) {
    var b = e.target.closest('[data-dock]'); if (!b || !CFG) return;
    var k = b.dataset.dock;
    if (k === 'cam') {
      var jardin = null;
      CFG.groups.forEach(function (g) { g.rooms.forEach(function (r) { if (r.camera) jardin = r; }); });
      if (jardin) { openRoom = jardin.id; render(); var el = document.getElementById('room-' + jardin.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      return;
    }
    if (!confirmed(b)) return;
    if (k === 'gate') return send(CFG.dock.gate, 100, { optimistic: false, msg: 'Portail : ouverture envoyée' });
    if (k === 'garage') return send(CFG.dock.garage, 1, { optimistic: false, msg: 'Garage : ouverture envoyée' });
    if (k === 'alarm') { var a = alarmArmed(); return send(CFG.dock.alarm, a ? 0 : 12, { msg: a ? 'Alarme désactivée' : 'Alarme activée' }); }
  });
  function findItem(id) {
    var f = null;
    CFG.groups.forEach(function (g) { g.rooms.forEach(function (r) { r.items.forEach(function (it) { if (it.id === id) f = it; }); }); });
    return f;
  }

  // ---------- Démarrage ----------
  fetch('config.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (c) {
    CFG = c;
    if (!token) return setup();
    render(); refresh();
    setInterval(function () { if (!document.hidden) refresh(); }, 10000);
    setInterval(function () { if (!document.hidden && lastOk) render(); }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  }).catch(function () { app.innerHTML = '<div class="setup"><h1>Maison</h1><p>Impossible de charger la configuration. Vérifie ta connexion.</p></div>'; });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
