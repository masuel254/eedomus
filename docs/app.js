/* Maison — appli de pilotage eedomus + Netatmo (PWA).
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
  }
  var userName = store.get('maison.name') || '';

  var token = store.get('maison.token');
  var CFG = null, LOG = null, STATES = {}, lastOk = 0, offline = false;
  var NT = null, ntErr = false, ntRoom = store.get('maison.ntRoom') || '';
  var ntPend = null;           // { room, temp, timer } : consigne en cours de réglage
  var CAMS = null, camsAt = 0, camsLoading = false, liveCam = null, liveHd = false;
  var IM = null, imAt = 0, imLoading = false;
  var openRoom = store.get('maison.open') || 'salon';
  var newVersion = false;
  var pending = {};            // id -> { value, until } : affichage immédiat avant confirmation
  var app = document.getElementById('app');
  var dock = document.getElementById('dock');
  var sheet = document.getElementById('sheet');
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
  function fmt(n, d) { return n == null || isNaN(n) ? '—' : Number(n).toFixed(d == null ? 1 : d).replace('.', ','); }
  function hhmm(ts) { return new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
  function dateFr(iso) { var d = new Date(iso + 'T12:00:00'); return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }
  function toast(msg, err) {
    toastEl.textContent = msg; toastEl.className = 'toast' + (err ? ' err' : ''); toastEl.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.hidden = true; }, 2400);
  }
  function ago(t) {
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 10) return "à l'instant"; if (s < 60) return 'il y a ' + s + ' s';
    return 'il y a ' + Math.round(s / 60) + ' min';
  }
  function busy() { return document.querySelector('.confirming, .armed-confirm'); }

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
      STATES = j.states; lastOk = Date.now(); offline = false; if (!busy()) render();
    }).catch(function (e) {
      if (e.status === 401) { token = null; return setup(); }
      offline = true; render();
    }).then(function () { refreshing = false; });
  }
  function refreshHeating() {
    if (!token) return;
    api({ action: 'nt.heating' }).then(function (j) { NT = j; ntErr = false; if (!busy()) render(); })
      .catch(function () { ntErr = true; if (!NT) render(); });
  }
  function loadCams(force) {
    if (camsLoading || (!force && CAMS && Date.now() - camsAt < 60000)) return;
    camsLoading = true;
    api({ action: 'nt.cameras', fresh: !!force }).then(function (j) { CAMS = j; camsAt = Date.now(); })
      .catch(function () { if (!CAMS) CAMS = { error: true, cameras: [], events: [] }; })
      .then(function () { camsLoading = false; if (!busy()) render(); if (!sheet.hidden && sheet.dataset.view === 'cams' && !sheet.querySelector('video')) renderCams(); });
  }
  // Imou : photos demandées seulement à l'ouverture des caméras (quota gratuit limité)
  function loadImou(force) {
    if (imLoading || (!force && IM && Date.now() - imAt < 120000)) return;
    imLoading = true;
    api({ action: 'im.cameras', snaps: true }).then(function (j) { IM = j; imAt = Date.now(); })
      .catch(function () { if (!IM) IM = { error: true, cameras: [] }; })
      .then(function () { imLoading = false; if (!busy()) render(); if (!sheet.hidden && sheet.dataset.view === 'cams' && !sheet.querySelector('video')) renderCams(); });
  }
  function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
  function allCams() {
    var a = [];
    if (CAMS && CAMS.cameras) CAMS.cameras.forEach(function (c) { a.push(Object.assign({ src: 'netatmo' }, c)); });
    if (IM && IM.cameras) IM.cameras.forEach(function (c) { a.push(Object.assign({ src: 'imou' }, c)); });
    var cc = (CFG && CFG.cameras) || {}, hidden = (cc.hidden || []).map(norm), order = (cc.order || []).map(norm);
    a = a.filter(function (c) { return hidden.indexOf(norm(c.name)) < 0; });
    var rank = function (c) { var i = order.indexOf(norm(c.name)); return i < 0 ? 99 : i; };
    return a.sort(function (x, y) { return rank(x) - rank(y); });
  }
  function roomCams(room) {
    return allCams().filter(function (c) { return (c.src === 'netatmo' && room.camera) || (c.src === 'imou' && norm(c.name) === norm(room.name)); });
  }
  function roomHasCam(room) {
    if (room.camera) return true;
    return !!(IM && IM.cameras && IM.cameras.some(function (c) { return norm(c.name) === norm(room.name); })) || ['cellier', 'piscine', 'jardin', 'garage', 'salon'].indexOf(norm(room.name)) >= 0;
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
  function ntCurrentRoom() {
    if (!NT || !NT.rooms || !NT.rooms.length) return null;
    return NT.rooms.filter(function (r) { return String(r.id) === String(ntRoom); })[0] || NT.rooms[0];
  }

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
    var nc = roomCams(room).length;
    if (nc) h += '<span class="mark">' + icon('cam') + nc + ' caméra' + (nc > 1 ? 's' : '') + '</span>';
    return '<span class="marks">' + h + '</span>';
  }

  // ---------- Rendu : lignes des pièces ----------
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

  // ---------- Rendu : chauffage (Netatmo) ----------
  var MODE_LABEL = { schedule: 'Planning', home: 'Planning', manual: 'Manuel', max: 'Boost', away: 'Absent', hg: 'Hors-gel', off: 'Arrêt' };
  function heroHTML() {
    var h = CFG.heating;
    var row3 = '<div class="row3"><span><b>' + fmt(num(h.outside), 1) + '°</b>Dehors</span><span><b>' + fmt(num(h.humidity), 0) + ' %</b>Humidité</span>';
    var r = ntCurrentRoom();
    if (!r) {
      var t0 = num(h.roomTemp);
      return '<section class="hero" aria-label="Chauffage"><div class="hero-top"><span>Chauffage</span><span class="badge soon">' + icon('flame') + (ntErr ? 'Netatmo indisponible' : 'Connexion…') + '</span></div>' +
        ring(t0, null, '<small>Intérieur</small>') + row3 + '<span><b>' + fmt(num(h.upstairs), 1) + '°</b>Étage</span></div></section>';
    }
    var sp = ntPend && String(ntPend.room) === String(r.id) ? ntPend.temp : r.setpoint;
    var heatingRooms = NT.rooms.filter(function (x) { return x.heating; }).length;
    var modeTxt = (MODE_LABEL[r.mode] || 'Planning') + (r.mode === 'manual' && r.end ? " jusqu'à " + hhmm(r.end) : '');
    var chips = NT.rooms.map(function (x) {
      return '<button class="rchip' + (x.id === r.id ? ' on' : '') + (x.heating ? ' heat' : '') + '" data-ntroom="' + esc(x.id) + '">' + esc(x.name) + ' <span>' + fmt(x.temp, 1) + '°</span></button>';
    }).join('');
    var homeMode = NT.mode || 'schedule';
    return '<section class="hero" aria-label="Chauffage">' +
      '<div class="hero-top"><span>Chauffage · ' + esc(r.name) + '</span>' +
      (r.heating ? '<span class="badge heat">' + icon('flame') + 'Chauffe</span>' : '<span class="badge soon">' + icon('flame') + 'Au repos</span>') + '</div>' +
      '<div class="dial"><button class="step" data-nt-step="-0.5" aria-label="Baisser la consigne">−</button>' +
      ring(r.temp, sp, '<em id="ntsp">Consigne ' + fmt(sp, 1) + '°</em><small>' + esc(modeTxt) + '</small>') +
      '<button class="step" data-nt-step="0.5" aria-label="Monter la consigne">+</button></div>' +
      (r.mode === 'manual' || r.mode === 'max' ? '<button class="back" data-nt-home>Revenir au planning</button>' : '') +
      '<div class="rchips">' + chips + '</div>' +
      '<div class="modes">' +
      '<button class="' + (homeMode === 'schedule' ? 'on' : '') + '" data-nt-mode="schedule">Planning</button>' +
      '<button class="' + (homeMode === 'away' ? 'on' : '') + '" data-nt-mode="away" data-confirm><span>Absent</span></button>' +
      '<button class="' + (homeMode === 'hg' ? 'on' : '') + '" data-nt-mode="hg" data-confirm><span>Hors-gel</span></button></div>' +
      row3 + '<span><b>' + heatingRooms + '</b>' + (heatingRooms > 1 ? 'Pièces chauffent' : 'Pièce chauffe') + '</span></div>' +
      '</section>';
  }
  function ring(temp, setpoint, sub) {
    var pct = setpoint != null ? (setpoint - 7) / 23 : temp == null ? 0 : (temp - 10) / 20;
    var arc = (Math.max(0, Math.min(1, pct)) * 377).toFixed(1);
    return '<div class="ring"><svg viewBox="0 0 190 190" aria-hidden="true">' +
      '<circle cx="95" cy="95" r="80" fill="none" stroke="#262B32" stroke-width="11" stroke-linecap="round" stroke-dasharray="377 503"/>' +
      '<circle id="ntarc" cx="95" cy="95" r="80" fill="none" stroke="#FF8A5B" stroke-width="11" stroke-linecap="round" stroke-dasharray="' + arc + ' 503"/></svg>' +
      '<div class="v"><b>' + fmt(temp, 1) + '°</b>' + sub + '</div></div>';
  }

  function chipsHTML() {
    var s = CFG.status;
    var armed = alarmArmed();
    var n = s.people.filter(function (id) { var v = val(id); return v !== undefined && v !== '0'; }).length;
    return '<div class="chips">' +
      '<button class="chip' + (armed ? ' armed' : '') + '" data-alarm data-confirm>' + icon('shield') + '<span>' + (armed ? 'Alarme activée' : 'Alarme désactivée') + '</span></button>' +
      '<span class="chip' + (n ? ' home' : '') + '">' + icon(n ? 'home' : 'leave') + (n ? n + ' personne' + (n > 1 ? 's' : '') + ' à la maison' : 'Personne à la maison') + '</span>' +
      '</div>';
  }

  function snapUrl(c) { return c.src === 'netatmo' ? c.snapshot + '?t=' + camsAt : c.snapshot; }
  function camPreviewHTML(room) {
    var cams = roomCams(room);
    if (!cams.length) return '<div class="cam"><div>' + icon('cam') + '<br>' + ((room.camera && !CAMS) || (!IM) ? 'Chargement des caméras…' : 'Caméra indisponible') + '</div></div>';
    return '<div class="camstrip' + (cams.length === 1 ? ' one' : '') + '">' + cams.map(function (c) {
      return '<button class="camthumb" data-opencams="' + esc(c.id) + '">' + (c.snapshot ? '<img alt="" src="' + esc(snapUrl(c)) + '">' : '') +
        '<span class="cname">' + esc(c.name) + '</span>' + (c.on ? '<span class="pill">LIVE</span>' : '<span class="pill off">Éteinte</span>') + '</button>';
    }).join('') + '</div>';
  }

  function roomsHTML() {
    return CFG.groups.map(function (g) {
      return '<div class="sec-hd"><h2>' + esc(g.name) + '</h2></div><div class="acc">' + g.rooms.map(function (r) {
        var o = r.id === openRoom, t = r.temp ? num(r.temp) : null;
        var hasCam = roomHasCam(r);
        if (o && r.camera) loadCams(false);
        if (o && hasCam) loadImou(false);
        return '<div class="acc-item' + (o ? ' open' : '') + '" id="room-' + r.id + '"><button class="acc-head" data-room="' + r.id + '" aria-expanded="' + o + '">' +
          '<span><b>' + esc(r.name) + '</b>' + marks(r) + '</span><span class="temp">' + (t == null ? '' : fmt(t, 1) + '°') + '</span><span class="chev">' + icon('down') + '</span></button>' +
          (o ? '<div class="acc-body">' + (hasCam ? camPreviewHTML(r) : '') + r.items.map(rowHTML).join('') + '</div>' : '') +
          '</div>';
      }).join('') + '</div>';
    }).join('');
  }

  function render() {
    if (!CFG || !token) return;
    var d = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    var y = window.scrollY;
    app.innerHTML =
      '<header class="hd"><div><small>' + esc(d.charAt(0).toUpperCase() + d.slice(1)) + '</small><h1>Bonjour' + (userName ? ' ' + esc(userName) : '') + '</h1></div>' +
      '<div class="hd-r"><div class="sync' + (offline ? ' off' : '') + '"><i></i>' + (offline ? 'Hors ligne' : lastOk ? ago(lastOk) : '…') + '</div>' +
      '<button class="gear' + (newVersion ? ' dot' : '') + '" data-settings aria-label="Réglages">' + icon('gear') + '</button></div></header>' +
      heroHTML() + chipsHTML() + roomsHTML() +
      '<button class="foot" data-settings>Maison v' + esc(LOG ? LOG.version : '…') + (lastOk ? ' · mis à jour ' + ago(lastOk) : '') + '</button>';
    window.scrollTo(0, y);
    dock.hidden = false;
    var da = dock.querySelector('[data-dock="alarm"]');
    if (!da.classList.contains('armed-confirm')) da.classList.toggle('armed', alarmArmed());
  }

  function setup() {
    dock.hidden = true;
    app.innerHTML = '<div class="setup"><h1>Maison</h1><p>Cette appli n\'est pas encore reliée à ta maison. Ouvre le lien d\'installation (QR code) depuis cet iPhone.</p></div>';
  }

  // ---------- Panneaux plein écran : caméras et réglages ----------
  function openSheet(view) {
    sheet.dataset.view = view; sheet.hidden = false; document.body.classList.add('noscroll');
    if (view === 'cams') { loadCams(true); loadImou(false); renderCams(); } else renderSettings();
  }
  function closeSheet() {
    sheet.hidden = true; sheet.innerHTML = ''; liveCam = null; liveHd = false; document.body.classList.remove('noscroll');
  }
  function camCardHTML(c) {
    var live = liveCam === c.id && c.live;
    var src = c.src === 'imou' && liveHd && c.liveHd ? c.liveHd : c.live;
    return '<div class="camcard" id="cc-' + esc(c.id) + '">' +
      (live ? '<video id="v-' + esc(c.id) + '" src="' + esc(src) + '" autoplay muted playsinline controls></video>'
        : '<button class="camimg" data-live="' + esc(c.id) + '"' + (c.live ? '' : ' disabled') + '>' + (c.snapshot ? '<img alt="" src="' + esc(snapUrl(c)) + '">' : '') +
          '<span class="play">' + icon('play') + (c.live ? 'Voir en direct' : 'Indisponible') + '</span></button>') +
      '<div class="cammeta"><b>' + esc(c.name) + '</b><span class="cm-r">' +
      (live && c.src === 'imou' && c.liveHd ? '<button class="hdbtn' + (liveHd ? ' on' : '') + '" data-hd>HD</button>' : '') +
      '<span class="' + (c.on ? 'ok' : 'bad') + '">' + (c.on ? 'En ligne' : 'Hors ligne') + '</span></span></div></div>';
  }
  var EV = { human: 'Personne', vehicle: 'Véhicule', animal: 'Animal', movement: 'Mouvement', outdoor: 'Mouvement', person: 'Personne' };
  function renderCams() {
    var h = '<div class="sh-hd"><h2>Caméras</h2><button class="close" data-close aria-label="Fermer">×</button></div>';
    var cams = allCams();
    h += cams.map(camCardHTML).join('');
    if (!CAMS || !IM) h += '<p class="muted">Chargement des caméras…</p>';
    if (IM && IM.error) h += '<p class="muted">Caméras Imou indisponibles pour le moment.</p>';
    h += '<p class="note-q">Vidéo Imou en qualité standard pour économiser les 2 Go gratuits. Touche « HD » pendant le direct pour la haute définition.</p>';
    if (CAMS && CAMS.cameras) {
      var names = {}; cams.forEach(function (c) { if (c.src === 'netatmo') names[c.id] = c.name; });
      var evs = (CAMS.events || []).filter(function (e) { return names[e.camera]; });
      h += '<h3>Derniers événements · ' + esc(Object.keys(names).map(function (k) { return names[k]; }).join(', ')) + '</h3>';
      h += evs.length ? '<div class="evlist">' + evs.map(function (e) {
        var day = new Date(e.time * 1000), today = new Date().toDateString() === day.toDateString();
        return '<div class="ev">' + (e.snapshot ? '<img alt="" loading="lazy" src="' + esc(e.snapshot) + '">' : '<span class="evic">' + icon('cam') + '</span>') +
          '<span><b>' + esc(EV[e.type] || 'Événement') + '</b><small>' + esc(names[e.camera] || '') + '</small></span>' +
          '<span class="evt">' + (today ? '' : day.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ') + hhmm(e.time) + '</span></div>';
      }).join('') + '</div>' : '<p class="muted">Aucun événement récent.</p>';
    }
    var keep = sheet.scrollTop;
    sheet.innerHTML = '<div class="sh-in">' + h + '</div>';
    sheet.scrollTop = keep;
    var v = liveCam && document.getElementById('v-' + liveCam);
    if (v) v.addEventListener('error', function () { toast('La vidéo en direct s\'ouvre dans Safari sur iPhone', true); });
    if (liveCam && sheet.dataset.jump === liveCam) { sheet.dataset.jump = ''; var cc = document.getElementById('cc-' + liveCam); if (cc) cc.scrollIntoView({ block: 'center' }); }
  }
  function renderSettings() {
    var L = LOG || { version: '—', releases: [], works: [], todo: [] };
    var h = '<div class="sh-hd"><h2>Réglages</h2><button class="close" data-close aria-label="Fermer">×</button></div>' +
      '<div class="card ver"><div><b>Maison</b><small>Version ' + esc(L.version) + (L.date ? ' · ' + esc(dateFr(L.date)) + (L.time ? ' à ' + esc(L.time) : '') : '') + '</small></div>' +
      '<button class="act" data-update>Vérifier</button></div>' +
      '<div class="card"><div class="kv"><span>Connecté en tant que</span><b>' + esc(userName || '—') + '</b></div>' +
      '<div class="kv"><span>Box eedomus</span><b class="' + (offline ? 'bad' : 'ok') + '">' + (offline ? 'Hors ligne' : lastOk ? 'Connectée' : '…') + '</b></div>' +
      '<div class="kv"><span>Netatmo</span><b class="' + (NT ? 'ok' : ntErr ? 'bad' : '') + '">' + (NT ? 'Connecté' : ntErr ? 'Indisponible' : '…') + '</b></div></div>' +
      '<h3>Suivi du projet</h3>' +
      '<details class="acc2"><summary><span>Ce qui fonctionne</span><span class="cnt ok">' + L.works.length + '</span>' + icon('down') + '</summary>' +
      '<ul class="lst ok">' + L.works.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></details>' +
      '<details class="acc2"><summary><span>Reste à faire</span><span class="cnt todo">' + L.todo.length + '</span>' + icon('down') + '</summary>' +
      '<ul class="lst todo">' + L.todo.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></details>' +
      '<h3>Historique des versions</h3>' + L.releases.map(function (r, i) {
        return '<details class="acc2 rel"><summary><span class="rel-v">v' + esc(r.version) + '</span>' +
          '<span class="rel-t"><b>' + esc(r.title) + '</b><small>' + esc(dateFr(r.date)) + (r.time ? ' à ' + esc(r.time) : '') + '</small></span>' +
          (i === 0 ? '<span class="new">Actuelle</span>' : '') + icon('down') + '</summary>' +
          '<ul>' + r.changes.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></details>';
      }).join('');
    sheet.innerHTML = '<div class="sh-in">' + h + '</div>';
    if (newVersion) { newVersion = false; store.set('maison.seenVersion', L.version); render(); }
  }

  // ---------- Confirmation en deux temps (portail, garage, alarme, modes) ----------
  function confirmed(btn) {
    if (!btn.hasAttribute('data-confirm')) return true;
    if (btn._armed) { clearTimeout(btn._armed); btn._armed = null; btn.classList.remove('confirming', 'armed-confirm'); return true; }
    var label = btn.querySelector('span') || btn, old = label.textContent;
    btn.classList.add(btn.closest('.dock') ? 'armed-confirm' : 'confirming');
    label.textContent = 'Confirmer ?';
    btn._armed = setTimeout(function () { btn._armed = null; btn.classList.remove('confirming', 'armed-confirm'); label.textContent = old; }, 3000);
    return false;
  }

  // ---------- Chauffage : réglage de la consigne ----------
  function stepSetpoint(delta) {
    var r = ntCurrentRoom(); if (!r) return;
    var base = ntPend && String(ntPend.room) === String(r.id) ? ntPend.temp : (r.setpoint || 19);
    var t = Math.max(7, Math.min(30, Math.round((base + delta) * 2) / 2));
    if (ntPend) clearTimeout(ntPend.timer);
    ntPend = { room: r.id, temp: t, timer: setTimeout(function () { commitSetpoint(r, t); }, 1200) };
    var el = document.getElementById('ntsp'); if (el) el.textContent = 'Consigne ' + fmt(t, 1) + '°';
    var arc = document.getElementById('ntarc'); if (arc) arc.setAttribute('stroke-dasharray', ((t - 7) / 23 * 377).toFixed(1) + ' 503');
  }
  function commitSetpoint(r, t) {
    api({ action: 'nt.setpoint', room: r.id, temp: t }).then(function (j) {
      NT = j; ntPend = null; render(); toast(r.name + ' : ' + fmt(t, 1) + '° (manuel)');
    }).catch(function () { ntPend = null; render(); toast('Netatmo ne répond pas, réessaie', true); });
  }

  // ---------- Interactions ----------
  app.addEventListener('click', function (e) {
    var b;
    if ((b = e.target.closest('[data-settings]'))) return openSheet('settings');
    if ((b = e.target.closest('[data-opencams]'))) { liveCam = b.dataset.opencams; sheet.dataset.jump = liveCam; return openSheet('cams'); }
    if ((b = e.target.closest('[data-ntroom]'))) { ntRoom = b.dataset.ntroom; store.set('maison.ntRoom', ntRoom); ntPend = null; return render(); }
    if ((b = e.target.closest('[data-nt-step]'))) return stepSetpoint(parseFloat(b.dataset.ntStep));
    if ((b = e.target.closest('[data-nt-home]'))) {
      var r = ntCurrentRoom();
      return api({ action: 'nt.setpoint', room: r.id, mode: 'home' }).then(function (j) { NT = j; render(); toast(r.name + ' : retour au planning'); })
        .catch(function () { toast('Netatmo ne répond pas, réessaie', true); });
    }
    if ((b = e.target.closest('[data-nt-mode]'))) {
      if (!confirmed(b)) return;
      var mode = b.dataset.ntMode;
      return api({ action: 'nt.mode', mode: mode }).then(function (j) { NT = j; render(); toast('Chauffage : ' + MODE_LABEL[mode]); })
        .catch(function () { toast('Netatmo ne répond pas, réessaie', true); });
    }
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
  sheet.addEventListener('click', function (e) {
    var b;
    if (e.target.closest('[data-close]')) return closeSheet();
    if ((b = e.target.closest('[data-live]'))) { liveCam = b.dataset.live; liveHd = false; return renderCams(); }
    if (e.target.closest('[data-hd]')) { liveHd = !liveHd; return renderCams(); }
    if (e.target.closest('[data-update]')) {
      toast('Recherche de mise à jour…');
      var done = function () { location.reload(); };
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then(function (reg) { return reg ? reg.update() : null; }).then(done, done);
      } else done();
    }
  });
  dock.addEventListener('click', function (e) {
    var b = e.target.closest('[data-dock]'); if (!b || !CFG) return;
    var k = b.dataset.dock;
    if (k === 'cam') { liveCam = null; return openSheet('cams'); }
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
  fetch('changelog.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (l) {
    LOG = l;
    var seen = store.get('maison.seenVersion');
    if (!seen) store.set('maison.seenVersion', l.version);
    else if (seen !== l.version) { newVersion = true; setTimeout(function () { toast('Nouvelle version ' + l.version + ' : touche ⚙︎ pour les nouveautés'); }, 1200); }
    render();
  }).catch(function () {});

  fetch('config.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (c) {
    CFG = c;
    if (!token) return setup();
    render(); refresh(); refreshHeating();
    setInterval(function () { if (!document.hidden) refresh(); }, 10000);
    setInterval(function () { if (!document.hidden && !ntPend) refreshHeating(); }, 30000);
    setInterval(function () { if (!document.hidden && lastOk && !busy()) render(); }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh(); refreshHeating(); } });
  }).catch(function () { app.innerHTML = '<div class="setup"><h1>Maison</h1><p>Impossible de charger la configuration. Vérifie ta connexion.</p></div>'; });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
