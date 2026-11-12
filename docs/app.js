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
  var CAMS = null, camsAt = 0, camsLoading = false, liveCam = null, liveHd = true;
  var IM = null, imAt = 0, imLoading = false;
  var TU = null, tuPend = {};   // Smart Life : état des appareils, actions en cours
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
  var refreshing = false, fails = 0;
  function refresh() {
    if (refreshing || !token) return; refreshing = true;
    api({ action: 'state' }).then(function (j) {
      STATES = j.states; lastOk = Date.now(); fails = 0; offline = false; if (!busy()) render();
    }).catch(function (e) {
      if (e.status === 401) { token = null; return setup(); }
      fails++;
      if (fails >= 2) { offline = true; render(); } else setTimeout(refresh, 3000); // une seule erreur : on réessaie vite, sans alarmer
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
  // Smart Life (Tuya) : sauna et compteurs de la piscine
  // iAquaLink (Zodiac) : électrolyseur eXO et pompe à chaleur
  var IQ = null, iqPend = {};
  function refreshIq(fresh) {
    if (!token) return;
    api({ action: 'iq.state', fresh: fresh === true }).then(function (j) { IQ = j; if (!sheet.hidden && sheet.dataset.view === 'timers' && !TED) renderTimers(); if (!busy() && !Object.keys(iqPend).some(function (k) { return iqPend[k].timer; })) render(); }).catch(function () { if (!IQ) IQ = { error: true }; });
  }
  function iqVal(dev, key, base) { var p = iqPend[dev + ':' + key]; return p && p.until > Date.now() ? p.v : base; }
  function iqSend(dev, key, value, msg) {
    iqPend[dev + ':' + key] = { v: value, until: Date.now() + 20000 };
    return api({ action: 'iq.set', dev: dev, key: key, value: value }).then(function () {
      toast(msg); setTimeout(function () { refreshIq(true); }, 4000); setTimeout(function () { refreshIq(true); }, 12000);
    }).catch(function (e) { delete iqPend[dev + ':' + key]; render(); toast(e.status === 403 ? 'Réglage non autorisé' : 'iAquaLink ne répond pas, réessaie', true); });
  }
  var SCH = { vsp: 'Filtration', swc: 'Électrolyse', aux: 'Auxiliaire' };
  function poolExoHTML(it) {
    if (!IQ) return '<div class="pool"><p class="muted">Lecture de l\'électrolyseur…</p></div>';
    var x = IQ.exo; if (!x) return '<div class="pool"><p class="muted">Électrolyseur indisponible pour le moment.</p></div>';
    var swc = iqVal('exo', 'swc', x.swc), ph = iqVal('exo', 'ph_sp', x.phSp), boost = iqVal('exo', 'boost', x.boost), pump = iqVal('exo', 'pump', x.pump), off = !x.online;
    var sub = [x.ph != null ? 'pH ' + fmt(x.ph, 1) : null, x.orp != null ? 'Redox ' + x.orp + ' mV' : null, x.water != null ? 'Eau ' + x.water + '°' : null].filter(Boolean).join(' · ');
    var progs = (x.schedules || []).filter(function (s) { return s.enabled; }).map(function (s) {
      var kind = SCH[String(s.endpoint || '').replace(/[_0-9]+$/, '')] || s.name;
      return { kind: kind, txt: s.start + '–' + s.end + (s.active ? ' (en cours)' : '') };
    });
    var byKind = {}; progs.forEach(function (p) { (byKind[p.kind] = byKind[p.kind] || []).push(p.txt); });
    return '<div class="pool' + (off ? ' off' : '') + '">' +
      '<div class="pool-hd"><span class="ic">' + icon('drop') + '</span><span><b>' + esc(it.name) + '</b><small>' + esc(sub || '—') + '</small></span>' +
      '<span class="pill2 ' + (off ? 'bad' : 'ok') + '">' + (off ? 'Hors ligne' : 'Connecté') + '</span></div>' +
      '<div class="pool-grid">' +
      '<div class="ctl"><small>Chloration</small><div class="stp"><button data-iq-step="exo:swc:-10"' + (off ? ' disabled' : '') + ' aria-label="Moins">−</button><b id="iq-exo-swc">' + (swc == null ? '—' : swc + ' %') + '</b><button data-iq-step="exo:swc:10"' + (off ? ' disabled' : '') + ' aria-label="Plus">+</button></div></div>' +
      '<div class="ctl"><small>Consigne pH</small><div class="stp"><button data-iq-step="exo:ph_sp:-0.1"' + (off ? ' disabled' : '') + ' aria-label="Moins">−</button><b id="iq-exo-ph_sp">' + (ph == null ? '—' : fmt(ph, 1)) + '</b><button data-iq-step="exo:ph_sp:0.1"' + (off ? ' disabled' : '') + ' aria-label="Plus">+</button></div></div>' +
      '<button class="ctl tog' + (boost ? ' is-on' : '') + '" data-iq-tog="exo:boost"' + (off ? ' disabled' : '') + '><small>Boost' + (boost && x.boostTime ? ' · ' + esc(x.boostTime) : '') + '</small><span class="sw"></span></button>' +
      '<button class="ctl tog' + (pump ? ' is-on' : '') + '" data-iq-tog="exo:pump"' + (off ? ' disabled' : '') + '><small>Filtration</small><span class="sw"></span></button>' +
      '</div>' +
      '<button class="pool-sched" data-timers>' + icon('cal') + '<span>' + (progs.length ? Object.keys(byKind).map(function (k) { return '<b>' + esc(k) + '</b> ' + esc(byKind[k].join(' · ')); }).join('<br>') : 'Aucun programme actif') +
      '</span><span class="pool-edit">Programmes' + icon('down') + '</span></button>' +
      '</div>';
  }
  function poolHpHTML(it) {
    if (!IQ) return '';
    var x = IQ.hp; if (!x) return '<div class="pool"><p class="muted">Pompe à chaleur indisponible pour le moment.</p></div>';
    var on = iqVal('hp', 'on', x.on ? 1 : 0), tsp = iqVal('hp', 'tsp', x.setpoint), off = !x.online;
    var pill = off ? 'Hors ligne' + (x.since ? ' depuis le ' + new Date(x.since).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '') : on ? (x.heating ? 'Chauffe' : 'En marche') : 'Arrêtée';
    var sub = [x.water != null ? 'Eau ' + fmt(x.water, 1) + '°' : null, x.air != null ? 'Air ' + fmt(x.air, 1) + '°' : null].filter(Boolean).join(' · ') + (off ? ' (dernières valeurs)' : '');
    return '<div class="pool' + (off ? ' off' : '') + '">' +
      '<div class="pool-hd"><span class="ic">' + icon('flame') + '</span><span><b>' + esc(it.name) + '</b><small>' + esc(sub || '—') + '</small></span>' +
      '<span class="pill2 ' + (off ? 'bad' : on ? 'heat' : '') + '">' + esc(pill) + '</span></div>' +
      '<div class="pool-grid">' +
      '<div class="ctl"><small>Consigne eau</small><div class="stp"><button data-iq-step="hp:tsp:-0.5"' + (off ? ' disabled' : '') + ' aria-label="Moins">−</button><b id="iq-hp-tsp">' + (tsp == null ? '—' : fmt(tsp, 1) + '°') + '</b><button data-iq-step="hp:tsp:0.5"' + (off ? ' disabled' : '') + ' aria-label="Plus">+</button></div></div>' +
      '<button class="ctl tog' + (on ? ' is-on heat' : '') + '" data-iq-tog="hp:on"' + (off ? ' disabled' : ' data-confirm') + '><small data-label>' + (off ? 'Dernier état : ' + (on ? 'marche' : 'arrêt') : on ? 'En marche' : 'Arrêtée') + '</small><span class="sw"></span></button>' +
      '</div>' +
      (off ? '<p class="note-q">La pompe à chaleur ne communique plus avec le cloud Zodiac. Rallume-la (ou vérifie son Wi-Fi) pour la piloter.</p>' : '') +
      '</div>';
  }
  var IQ_LIM = { swc: [0, 100], ph_sp: [6.8, 7.6], tsp: [15, 32] };
  function iqStep(dev, key, delta) {
    var cur = dev === 'exo' ? (key === 'swc' ? IQ.exo.swc : IQ.exo.phSp) : IQ.hp.setpoint;
    var p = iqPend[dev + ':' + key], base = p ? p.v : cur;
    if (base == null) return;
    var lim = IQ_LIM[key], v = Math.round((base + delta) * 10) / 10;
    v = Math.max(lim[0], Math.min(lim[1], v));
    if (p && p.timer) clearTimeout(p.timer);
    var el = document.getElementById('iq-' + dev + '-' + key);
    if (el) el.textContent = key === 'swc' ? v + ' %' : key === 'tsp' ? fmt(v, 1) + '°' : fmt(v, 1);
    var label = key === 'swc' ? 'Chloration : ' + v + ' %' : key === 'ph_sp' ? 'Consigne pH : ' + fmt(v, 1) : 'Consigne eau : ' + fmt(v, 1) + '°';
    iqPend[dev + ':' + key] = { v: v, until: Date.now() + 20000, timer: setTimeout(function () { iqPend[dev + ':' + key].timer = null; iqSend(dev, key, v, label); }, 1200) };
  }

  function refreshTuya(fresh) {
    if (!token) return;
    api({ action: 'tu.state', fresh: fresh === true }).then(function (j) { TU = j; if (!busy()) render(); }).catch(function () {});
  }
  function tuDev(key) { return TU && TU.devices ? TU.devices[key] : null; }
  function tuOn(key) { var p = tuPend[key]; if (p && p.until > Date.now()) return p.on; var d = tuDev(key); return !!(d && d.on); }
  function watts(w) { return w == null ? '—' : w >= 1000 ? fmt(w / 1000, 2) + ' kW' : fmt(w, 0) + ' W'; }

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
    var kw = 0, hasMeter = false;
    room.items.forEach(function (it) {
      if (it.type === 'tuya-switch' && tuOn(it.key)) h += '<span class="mark heat">' + icon(it.icon || 'flame') + esc(it.name) + ' allumé</span>';
      if (it.type === 'tuya-meter' && tuDev(it.key)) { hasMeter = true; kw += tuDev(it.key).power || 0; }
    });
    if (hasMeter) h += '<span class="mark' + (kw > 5 ? ' l' : '') + '">' + icon('bolt') + watts(kw) + '</span>';
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
    if (it.type === 'iaqua-exo') return poolExoHTML(it);
    if (it.type === 'iaqua-hp') return poolHpHTML(it);
    if (it.type === 'tuya-switch') {
      var d = tuDev(it.key), son = tuOn(it.key);
      var sub = !d ? 'Chargement…' : son ? 'Allumé' + (d.power > 5 ? ' · chauffe ' + watts(d.power) : '') : 'Éteint';
      return '<button class="row' + (son ? ' is-on heat' : '') + (tuPend[it.key] ? ' busy' : '') + '" data-tuya="' + esc(it.key) + '"' + (son ? '' : ' data-confirm') + '>' +
        '<span class="ic">' + icon(it.icon || 'flame') + '</span><span><b>' + esc(it.name) + '</b><small data-label>' + esc(sub) + '</small></span><span class="sw"></span></button>';
    }
    if (it.type === 'tuya-meter') {
      var m = tuDev(it.key), running = m && m.power > 5;
      var msub = !m ? 'Chargement…' : m.on === false ? 'Coupé par son compteur' : running ? 'En marche' : "À l'arrêt";
      if (m && m.energy != null) msub += ' · index ' + fmt(m.energy, 0) + ' kWh';
      msub += ' · détails';
      return '<button class="row meter' + (running ? ' run' : '') + '" data-energy="' + esc(it.key) + '" data-ename="' + esc(it.label || it.name) + '"><span class="ic">' + icon(it.icon || 'bolt') + '</span><span><b>' + esc(it.name) + '</b><small>' + esc(msub) + '</small></span>' +
        '<span class="val">' + (m ? watts(m.power) : '—') + '</span></button>';
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
      schedHTML() +
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
  // Planning Netatmo en cours (« Défaut · jusqu'à 18:00 ») et choix du planning
  var schedOpen = false;
  function schedHTML() {
    if (!NT || !NT.schedule) return '';
    var s = NT.slot || {}, when = '';
    if (NT.mode === 'away') when = 'Mode Absent';
    else if (NT.mode === 'hg') when = 'Mode Hors-gel';
    else if (s.until) {
      var dayTxt = s.untilDay === 'today' || s.untilDay === 'week' ? '' : s.untilDay === 'tomorrow' ? 'demain ' : s.untilDay + ' ';
      when = (s.zone ? s.zone + ' · ' : '') + "jusqu'à " + dayTxt + s.until;
    }
    else if (s.zone) when = s.zone;
    var h = '<button class="sched' + (schedOpen ? ' open' : '') + '" data-sched-toggle aria-expanded="' + schedOpen + '">' +
      '<span class="sched-ic">' + icon('cal') + '</span><span class="sched-t"><b>' + esc(NT.schedule) + '</b><small>' + esc(when) + '</small></span>' +
      '<span class="sched-ch">Changer' + icon('down') + '</span></button>';
    if (schedOpen) {
      h += '<div class="schedlist">' + (NT.schedules || []).map(function (x) {
        return '<button class="' + (String(x.id) === String(NT.scheduleId) ? 'on' : '') + '" data-sched="' + esc(x.id) + '">' + esc(x.name) + '</button>';
      }).join('') + '</div>';
    }
    return h;
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
    if (view === 'cams') { loadCams(true); loadImou(false); renderCams(); }
    else if (view === 'rec') renderRec();
    else if (view === 'energy') renderEnergy();
    else if (view === 'timers') renderTimers();
    else renderSettings();
  }
  function closeSheet() {
    sheet.hidden = true; sheet.innerHTML = ''; liveCam = null; liveHd = true; REC = null; ENG = null; TED = null; document.body.classList.remove('noscroll');
  }

  // ---------- Programmes (timers) de l'électrolyseur eXO, comme dans iAquaLink ----------
  var TED = null; // timer en cours de modification : { sch, start, end, rpm }
  var TGROUPS = [['Timers 1', ['sch5', 'sch1']], ['Timers 2', ['sch6', 'sch2']], ['Timers 3', ['sch7']], ['Timers 4', ['sch8']], ['Timer Aux 1', ['sch9']], ['Timer Aux 2', ['sch10']]];
  var TNAME = { sch5: 'Filtration 1', sch6: 'Filtration 2', sch7: 'Filtration 3', sch8: 'Filtration 4', sch1: 'Électrolyseur 1', sch2: 'Électrolyseur 2', sch9: 'Aux 1', sch10: 'Aux 2' };
  function tByKey() { var m = {}; ((IQ && IQ.exo && IQ.exo.schedules) || []).forEach(function (s) { m[s.key] = s; }); return m; }
  function renderTimers() {
    var S = tByKey(), h = '<div class="sh-hd"><h2>Programmes</h2><button class="close" data-close aria-label="Fermer">×</button></div>';
    if (!IQ || !IQ.exo) { sheet.innerHTML = '<div class="sh-in">' + h + '<p class="muted">Lecture de l\'électrolyseur…</p></div>'; return; }
    h += '<p class="note-q">Touche un programme pour le modifier. Mettre la même heure de début et de fin (00:00 – 00:00) le désactive.</p>';
    TGROUPS.forEach(function (g) {
      h += '<h3>' + esc(g[0]) + '</h3><div class="evlist">';
      g[1].forEach(function (k) {
        var s = S[k]; if (!s) return;
        var open = TED && TED.sch === k;
        h += '<button class="tm' + (s.enabled ? ' on' : '') + (open ? ' open' : '') + '" data-tm="' + k + '"><span><b>' + esc(TNAME[k]) + '</b><small>' +
          (s.enabled ? esc(s.start) + ' – ' + esc(s.end) + (s.active ? ' · en cours' : '') : 'Désactivé') + '</small></span>' +
          (s.rpm ? '<span class="tm-rpm">' + s.rpm + ' tr/min</span>' : '<span></span>') + icon('down') + '</button>';
        if (open) {
          h += '<div class="ted"><div class="ted-row"><label for="ted-start">Début</label><input id="ted-start" type="time" value="' + esc(TED.start) + '"></div>' +
            '<div class="ted-row"><label for="ted-end">Fin</label><input id="ted-end" type="time" value="' + esc(TED.end) + '"></div>' +
            (TED.rpm != null ? '<div class="ted-row"><label>Vitesse pompe</label><div class="stp"><button data-ted-rpm="-100" aria-label="Moins">−</button><b id="ted-rpm">' + TED.rpm + '</b><button data-ted-rpm="100" aria-label="Plus">+</button></div></div>' : '') +
            '<div class="ted-btns"><button class="act" data-ted-off>Désactiver</button><button class="act primary" data-ted-save>Enregistrer</button></div></div>';
        }
      });
      h += '</div>';
    });
    var keep = sheet.scrollTop;
    sheet.innerHTML = '<div class="sh-in">' + h + '</div>';
    sheet.scrollTop = keep;
  }
  function saveTimer(start, end) {
    var t = TED; if (!t) return;
    var body = { action: 'iq.sched', sch: t.sch, start: start, end: end };
    if (t.rpm != null) body.rpm = t.rpm;
    toast('Envoi du programme…');
    api(body).then(function () {
      // affichage immédiat, puis relecture de l'état réel
      var s = tByKey()[t.sch]; if (s) { s.start = start; s.end = end; s.enabled = start !== end; if (t.rpm != null) s.rpm = t.rpm; }
      TED = null; renderTimers(); render();
      toast(TNAME[t.sch] + (start === end ? ' désactivé' : ' : ' + start + ' – ' + end));
      setTimeout(function () { refreshIq(true); }, 5000);
      setTimeout(function () { refreshIq(true); if (!sheet.hidden && sheet.dataset.view === 'timers' && !TED) renderTimers(); }, 15000);
    }).catch(function (e) { toast(e.status === 403 ? 'Horaire invalide' : 'iAquaLink ne répond pas, réessaie', true); });
  }
  function camCardHTML(c) {
    var live = liveCam === c.id && c.live;
    var src = c.src === 'imou' && liveHd && c.liveHd ? c.liveHd : c.live;
    return '<div class="camcard" id="cc-' + esc(c.id) + '">' +
      (live ? '<video id="v-' + esc(c.id) + '" src="' + esc(src) + '" autoplay muted playsinline controls></video>'
        : '<button class="camimg" data-live="' + esc(c.id) + '"' + (c.live ? '' : ' disabled') + '>' + (c.snapshot ? '<img alt="" src="' + esc(snapUrl(c)) + '">' : '') +
          '<span class="play">' + icon('play') + (c.live ? 'Voir en direct' : 'Indisponible') + '</span></button>') +
      '<div class="cammeta"><b>' + esc(c.name) + '</b><span class="cm-r">' +
      (live && c.src === 'imou' && c.liveHd ? '<button class="hdbtn' + (liveHd ? ' on' : '') + '" data-hd>' + (liveHd ? 'HD' : 'SD') + '</button>' : '') +
      '<button class="recbtn" data-rec="' + esc(c.id) + '">' + icon('rec') + 'Enregistrements</button>' +
      '<span class="' + (c.on ? 'ok' : 'bad') + '">' + (c.on ? 'En ligne' : 'Hors ligne') + '</span></span></div></div>';
  }

  // ---------- Enregistrements : carte SD Imou (par jour) et clips d'événements Netatmo ----------
  var REC = null; // { cam, date, list, loading, error, play: { url, label } }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function camById(id) { return allCams().filter(function (c) { return c.id === id; })[0] || null; }
  function openRec(camId, play) {
    REC = { cam: camId, date: ymd(new Date()), list: null, loading: false, error: false, play: play || null };
    liveCam = null; sheet.scrollTop = 0; openSheet('rec'); loadRec();
  }
  function loadRec() {
    var c = REC && camById(REC.cam); if (!c || c.src !== 'imou') return;
    REC.loading = true; REC.error = false; var want = REC.date;
    api({ action: 'im.records', cam: c.id, date: want }).then(function (j) { if (REC && REC.date === want) { REC.list = j.records; REC.loading = false; renderRec(); } })
      .catch(function () { if (REC) { REC.loading = false; REC.error = true; renderRec(); } });
    renderRec();
  }
  var RT = { videomotion: 'Mouvement', alarm: 'Alarme', human: 'Personne', manual: 'Manuel', regular: 'Continu', all: 'Enregistrement' };
  function dur(a, b) {
    var s = Math.max(0, (new Date(b.replace(' ', 'T')) - new Date(a.replace(' ', 'T'))) / 1000);
    return s < 60 ? Math.round(s) + ' s' : Math.floor(s / 60) + ' min ' + String(Math.round(s % 60)).padStart(2, '0');
  }
  function renderRec() {
    if (!REC) return;
    var c = camById(REC.cam);
    var h = '<div class="sh-hd"><button class="back2" data-recback>' + icon('down') + 'Caméras</button><button class="close" data-close aria-label="Fermer">×</button></div>' +
      '<h2 class="rec-title">' + esc(c ? c.name : 'Caméra') + ' · enregistrements</h2>';
    h += REC.play ? '<div class="camcard player"><video id="recv" src="' + esc(REC.play.url) + '" autoplay playsinline controls></video>' +
      '<div class="cammeta"><b>' + esc(REC.play.label) + '</b></div></div>'
      : '<div class="camcard player empty"><span>' + icon('play') + 'Choisis un enregistrement ci-dessous</span></div>';
    if (c && c.src === 'imou') {
      var days = '';
      for (var i = 0; i < 7; i++) {
        var d = new Date(); d.setDate(d.getDate() - i);
        var lbl = i === 0 ? "Aujourd'hui" : i === 1 ? 'Hier' : d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
        days += '<button class="' + (ymd(d) === REC.date ? 'on' : '') + '" data-recday="' + ymd(d) + '">' + esc(lbl) + '</button>';
      }
      h += '<div class="days">' + days + '</div>';
      if (REC.loading && !REC.list) h += '<p class="muted">Lecture de la carte SD…</p>';
      else if (REC.error) h += '<p class="muted">La caméra ne répond pas. Réessaie dans un instant.</p>';
      else if (REC.list && !REC.list.length) h += '<p class="muted">Aucun enregistrement ce jour-là.</p>';
      else if (REC.list) h += '<div class="evlist">' + REC.list.map(function (r, i) {
        var playing = REC.play && REC.play.key === r.begin;
        return '<button class="ev rec' + (playing ? ' on' : '') + '" data-recplay="' + i + '"><span class="evic">' + icon('play') + '</span>' +
          '<span><b>' + esc(r.begin.slice(11, 16)) + ' → ' + esc(r.end.slice(11, 16)) + '</b><small>' + esc(RT[String(r.type || '').toLowerCase()] || 'Enregistrement') + ' · ' + dur(r.begin, r.end) + '</small></span>' +
          '<span class="evt">' + (r.size ? fmt(r.size / 1048576, 1) + ' Mo' : '') + '</span></button>';
      }).join('') + '</div>';
      h += '<p class="note-q">Enregistrements de la carte SD de la caméra. La lecture consomme le forfait vidéo Imou (2 Go gratuits).</p>';
    } else if (c) {
      var evs = ((CAMS && CAMS.events) || []).filter(function (e) { return e.camera === c.id && e.video; });
      h += evs.length ? '<div class="evlist">' + evs.map(function (e) {
        var day = new Date(e.time * 1000), today = new Date().toDateString() === day.toDateString();
        var playing = REC.play && REC.play.key === e.id;
        return '<button class="ev rec' + (playing ? ' on' : '') + '" data-evplay="' + esc(e.id) + '">' + (e.snapshot ? '<img alt="" loading="lazy" src="' + esc(e.snapshot) + '">' : '<span class="evic">' + icon('cam') + '</span>') +
          '<span><b>' + esc(EV[e.type] || 'Événement') + '</b><small>' + (today ? "Aujourd'hui" : day.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })) + '</small></span>' +
          '<span class="evt">' + hhmm(e.time) + '</span></button>';
      }).join('') + '</div>' : '<p class="muted">Aucun clip disponible pour le moment.</p>';
      h += '<p class="note-q">Clips des derniers événements, lus depuis la carte SD de la caméra.</p>';
    }
    var keep = sheet.scrollTop;
    sheet.innerHTML = '<div class="sh-in">' + h + '</div>';
    sheet.scrollTop = keep;
  }
  // ---------- Consommation électrique (électrolyseur, pompe à chaleur, sauna) ----------
  var ENG = null; // { key, name, tab: 'day'|'month'|'year', day: 'AAAAMMJJ', month: 'AAAAMM', year: 'AAAA', data, loading }
  function ymdK(d) { return ymd(d).replace(/-/g, ''); }
  function openEnergy(key, name) {
    var t = new Date();
    ENG = { key: key, name: name, tab: 'day', day: ymdK(t), month: ymdK(t).slice(0, 6), year: String(t.getFullYear()), data: null, loading: true };
    sheet.scrollTop = 0; openSheet('energy'); loadEnergy();
  }
  function loadEnergy() {
    if (!ENG) return; var k = ENG.key;
    api({ action: 'tu.energy', key: k }).then(function (j) { if (ENG && ENG.key === k) { ENG.data = j; ENG.loading = false; renderEnergy(); } })
      .catch(function () { if (ENG) { ENG.loading = false; ENG.error = true; renderEnergy(); } });
  }
  function kwh(v) { return v == null ? '—' : v < 10 ? fmt(v, 2) : v < 100 ? fmt(v, 1) : fmt(v, 0); }
  function bars(vals, labels, hi) {
    // Histogramme SVG : vals = [nombre|null], labels = { index: texte }, hi = index mis en avant
    var n = vals.length, W = 320, H = 150, top = 8, base = 124, gap = n > 20 ? 2 : 4, bw = (W - gap * (n - 1)) / n;
    var max = Math.max.apply(null, vals.map(function (v) { return v || 0; }).concat([0.001]));
    var s = '<svg class="bars" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Consommation">';
    s += '<line x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '" class="axis"/>';
    vals.forEach(function (v, i) {
      var x = i * (bw + gap), h = v == null ? 0 : Math.max(v > 0 ? 3 : 1.5, (v / max) * (base - top));
      if (v == null) s += '<rect x="' + x.toFixed(1) + '" y="' + (base - 1.5) + '" width="' + bw.toFixed(1) + '" height="1.5" rx="0.75" class="b-empty"/>';
      else s += '<rect x="' + x.toFixed(1) + '" y="' + (base - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="' + Math.min(3, bw / 2).toFixed(1) + '" class="' + (i === hi ? 'b-hi' : 'b') + '"><title>' + kwh(v) + ' kWh</title></rect>';
      if (labels[i] !== undefined) { var anc = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', lx = i === 0 ? x : i === n - 1 ? x + bw : x + bw / 2; s += '<text x="' + lx.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + anc + '" class="lbl">' + labels[i] + '</text>'; }
    });
    return s + '</svg>';
  }
  function renderEnergy() {
    if (!ENG) return;
    var D = ENG.data || {}, now = D.now || {}, h = '';
    h += '<div class="sh-hd"><h2>' + esc(ENG.name) + '</h2><button class="close" data-close aria-label="Fermer">×</button></div>';
    if (ENG.loading && !ENG.data) { sheet.innerHTML = '<div class="sh-in">' + h + '<p class="muted">Chargement…</p></div>'; return; }
    if (ENG.error && !ENG.data) { sheet.innerHTML = '<div class="sh-in">' + h + '<p class="muted">Smart Life ne répond pas, réessaie dans un instant.</p></div>'; return; }
    // En-tête : index total (compteurs) ou énergie cumulée depuis le début des relevés (sauna)
    h += '<div class="en-total"><b>' + (now.energy != null ? fmt(now.energy, 2) : kwh(D.index)) + '</b><small>' + icon('bolt') +
      (now.energy != null ? 'Index total (kWh)' : 'kWh mesurés depuis le début des relevés') + '</small></div>';
    h += '<div class="en-live"><div><small>Puissance</small><b>' + watts(now.power) + '</b></div><div><small>Courant</small><b>' + (now.current == null ? '—' : fmt(now.current, 2) + ' A') + '</b></div>' +
      '<div><small>Tension</small><b>' + (now.voltage == null ? '—' : fmt(now.voltage, 1) + ' V') + '</b></div></div>';
    h += '<div class="en-tabs">' + [['day', 'Jour'], ['month', 'Mois'], ['year', 'Année']].map(function (t) {
      return '<button class="' + (ENG.tab === t[0] ? 'on' : '') + '" data-entab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>';
    var hours = {}, days = {}; (D.hours || []).forEach(function (x) { hours[x.k] = x.kwh; }); (D.days || []).forEach(function (x) { days[x.k] = x.kwh; });
    var vals = [], labels = {}, total = 0, any = false, title = '', hi = -1, today = ymdK(new Date());
    if (ENG.tab === 'day') {
      for (var i = 0; i < 24; i++) { var hk = ENG.day + String(i).padStart(2, '0'), v = hours[hk]; vals.push(v === undefined ? null : v); if (v !== undefined) { total += v; any = true; } }
      [0, 6, 12, 18, 23].forEach(function (i) { labels[i] = String(i).padStart(2, '0') + 'h'; });
      if (ENG.day === today) hi = new Date().getHours();
      var dd = new Date(+ENG.day.slice(0, 4), +ENG.day.slice(4, 6) - 1, +ENG.day.slice(6, 8));
      title = ENG.day === today ? "Aujourd'hui" : dd.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
      if (days[ENG.day] !== undefined) total = days[ENG.day];
    } else if (ENG.tab === 'month') {
      var y = +ENG.month.slice(0, 4), mo = +ENG.month.slice(4, 6), nd = new Date(y, mo, 0).getDate();
      for (var d = 1; d <= nd; d++) { var dk = ENG.month + String(d).padStart(2, '0'), dv = days[dk]; vals.push(dv === undefined ? null : dv); if (dv !== undefined) { total += dv; any = true; } }
      [0, 9, 19, nd - 1].forEach(function (i) { labels[i] = String(i + 1); });
      if (ENG.month === today.slice(0, 6)) hi = new Date().getDate() - 1;
      title = new Date(y, mo - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    } else {
      for (var mm = 1; mm <= 12; mm++) {
        var pre = ENG.year + String(mm).padStart(2, '0'), sum = null;
        Object.keys(days).forEach(function (k) { if (k.slice(0, 6) === pre) sum = (sum || 0) + days[k]; });
        vals.push(sum); if (sum != null) { total += sum; any = true; }
      }
      'JFMAMJJASOND'.split('').forEach(function (c, i) { labels[i] = c; });
      if (ENG.year === today.slice(0, 4)) hi = new Date().getMonth();
      title = ENG.year;
    }
    if (ENG.tab === 'day' && days[ENG.day] !== undefined) any = true;
    h += '<div class="en-card"><div class="en-period"><button data-enstep="-1" aria-label="Période précédente">' + icon('down') + '</button><span>' + esc(title.charAt(0).toUpperCase() + title.slice(1)) + '</span>' +
      '<button data-enstep="1" aria-label="Période suivante">' + icon('down') + '</button></div>' +
      '<div class="en-sum"><b>' + (any ? kwh(total) : '—') + '</b> kWh</div>' + bars(vals, labels, hi) + '</div>';
    if (D.since) {
      var s = D.since;
      h += '<p class="note-q">Historique enregistré par la maison depuis le ' + (+s.slice(6, 8)) + '/' + s.slice(4, 6) + '/' + s.slice(0, 4) +
        '. Les jours précédents de Smart Life ne sont pas accessibles. Détail heure par heure gardé 8 jours, jours et mois gardés 2 ans.</p>';
    }
    var keep = sheet.scrollTop;
    sheet.innerHTML = '<div class="sh-in">' + h + '</div>';
    sheet.scrollTop = keep;
  }
  function stepEnergy(dir) {
    if (!ENG) return;
    if (ENG.tab === 'day') { var d = new Date(+ENG.day.slice(0, 4), +ENG.day.slice(4, 6) - 1, +ENG.day.slice(6, 8) + dir); if (d > new Date()) return; ENG.day = ymdK(d); }
    else if (ENG.tab === 'month') { var m = new Date(+ENG.month.slice(0, 4), +ENG.month.slice(4, 6) - 1 + dir, 1); if (m > new Date()) return; ENG.month = ymdK(m).slice(0, 6); }
    else { var y = +ENG.year + dir; if (y > new Date().getFullYear()) return; ENG.year = String(y); }
    renderEnergy();
  }

  function playEvent(id) {
    var e = ((CAMS && CAMS.events) || []).filter(function (x) { return x.id === id; })[0]; if (!e || !e.video) return;
    var lbl = (EV[e.type] || 'Événement') + ' · ' + new Date(e.time * 1000).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    if (!REC || REC.cam !== e.camera) return openRec(e.camera, { url: e.video, label: lbl, key: e.id });
    REC.play = { url: e.video, label: lbl, key: e.id }; sheet.scrollTop = 0; renderRec();
  }
  var EV = { human: 'Personne', vehicle: 'Véhicule', animal: 'Animal', movement: 'Mouvement', outdoor: 'Mouvement', person: 'Personne' };
  function renderCams() {
    var h = '<div class="sh-hd"><h2>Caméras</h2><button class="close" data-close aria-label="Fermer">×</button></div>';
    var cams = allCams();
    h += cams.map(camCardHTML).join('');
    if (!CAMS || !IM) h += '<p class="muted">Chargement des caméras…</p>';
    if (IM && IM.error) h += '<p class="muted">Caméras Imou indisponibles pour le moment.</p>';
    h += '<p class="note-q">Direct Imou en HD. Touche « HD » pendant le direct pour passer en SD et économiser le forfait vidéo (2 Go gratuits).</p>';
    if (CAMS && CAMS.cameras) {
      var names = {}; cams.forEach(function (c) { if (c.src === 'netatmo') names[c.id] = c.name; });
      var evs = (CAMS.events || []).filter(function (e) { return names[e.camera]; });
      h += '<h3>Derniers événements · ' + esc(Object.keys(names).map(function (k) { return names[k]; }).join(', ')) + '</h3>';
      h += evs.length ? '<div class="evlist">' + evs.map(function (e) {
        var day = new Date(e.time * 1000), today = new Date().toDateString() === day.toDateString();
        var tag = e.video ? 'button' : 'div';
        return '<' + tag + ' class="ev' + (e.video ? ' rec' : '') + '"' + (e.video ? ' data-evplay="' + esc(e.id) + '"' : '') + '>' + (e.snapshot ? '<img alt="" loading="lazy" src="' + esc(e.snapshot) + '">' : '<span class="evic">' + icon('cam') + '</span>') +
          '<span><b>' + esc(EV[e.type] || 'Événement') + '</b><small>' + esc(names[e.camera] || '') + (e.video ? ' · voir le clip' : '') + '</small></span>' +
          '<span class="evt">' + (today ? '' : day.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ') + hhmm(e.time) + '</span></' + tag + '>';
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
    var label = btn.querySelector('[data-label]') || btn.querySelector('span') || btn, old = label.textContent;
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
    if (e.target.closest('[data-sched-toggle]')) { schedOpen = !schedOpen; return render(); }
    if ((b = e.target.closest('[data-sched]'))) {
      var sid = b.dataset.sched, sname = b.textContent;
      if (NT && String(sid) === String(NT.scheduleId)) { schedOpen = false; return render(); }
      b.classList.add('busy');
      return api({ action: 'nt.schedule', id: sid }).then(function (j) { NT = j; schedOpen = false; render(); toast('Planning : ' + sname); })
        .catch(function () { b.classList.remove('busy'); toast('Netatmo ne répond pas, réessaie', true); });
    }
    if ((b = e.target.closest('[data-nt-mode]'))) {
      if (!confirmed(b)) return;
      var mode = b.dataset.ntMode;
      return api({ action: 'nt.mode', mode: mode }).then(function (j) { NT = j; render(); toast('Chauffage : ' + MODE_LABEL[mode]); })
        .catch(function () { toast('Netatmo ne répond pas, réessaie', true); });
    }
    if ((b = e.target.closest('[data-room]'))) {
      openRoom = openRoom === b.dataset.room ? '' : b.dataset.room; store.set('maison.open', openRoom);
      // Pièce avec un appareil Smart Life (sauna, compteurs) : état frais tout de suite
      CFG.groups.forEach(function (g) { g.rooms.forEach(function (rm) {
        if (rm.id === openRoom && rm.items.some(function (it) { return /^tuya-/.test(it.type); })) refreshTuya(true);
        if (rm.id === openRoom && rm.items.some(function (it) { return /^iaqua-/.test(it.type); })) refreshIq(true);
      }); });
      return render();
    }
    if (e.target.closest('[data-timers]')) { TED = null; sheet.scrollTop = 0; openSheet('timers'); refreshIq(true); return; }
    if ((b = e.target.closest('[data-iq-step]'))) {
      var ps = b.dataset.iqStep.split(':'); return iqStep(ps[0], ps[1], parseFloat(ps[2]));
    }
    if ((b = e.target.closest('[data-iq-tog]'))) {
      if (!confirmed(b)) return;
      var pt = b.dataset.iqTog.split(':'), dv = pt[0], ky = pt[1];
      var curV = dv === 'exo' ? iqVal('exo', ky, IQ.exo[ky]) : iqVal('hp', 'on', IQ.hp.on ? 1 : 0);
      var nv = curV ? 0 : 1;
      var names = { 'exo:boost': 'Boost', 'exo:pump': 'Filtration', 'hp:on': 'Pompe à chaleur' };
      iqPend[dv + ':' + ky] = { v: nv, until: Date.now() + 20000 }; render();
      return iqSend(dv, ky, nv, names[dv + ':' + ky] + (nv ? ' : marche' : ' : arrêt'));
    }
    if ((b = e.target.closest('[data-energy]'))) return openEnergy(b.dataset.energy, b.dataset.ename);
    if ((b = e.target.closest('[data-tuya]'))) {
      if (!confirmed(b)) return;
      var key = b.dataset.tuya, want = !tuOn(key), nameT = b.querySelector('b').textContent;
      tuPend[key] = { on: want, until: Date.now() + 10000 }; render();
      return api({ action: 'tu.switch', key: key, on: want }).then(function () {
        toast(nameT + (want ? ' allumé' : ' éteint')); setTimeout(refreshTuya, 2500); setTimeout(refreshTuya, 8000);
      }).catch(function () { delete tuPend[key]; render(); toast(nameT + ' ne répond pas, réessaie', true); });
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
    if ((b = e.target.closest('[data-live]'))) { liveCam = b.dataset.live; liveHd = true; return renderCams(); }
    if (e.target.closest('[data-hd]')) { liveHd = !liveHd; return renderCams(); }
    if ((b = e.target.closest('[data-rec]'))) return openRec(b.dataset.rec);
    if ((b = e.target.closest('[data-entab]'))) { ENG.tab = b.dataset.entab; return renderEnergy(); }
    if ((b = e.target.closest('[data-tm]'))) {
      var k = b.dataset.tm, s = tByKey()[k];
      if (TED && TED.sch === k) TED = null;
      else TED = { sch: k, start: s.enabled ? s.start : '08:00', end: s.enabled ? s.end : '10:00', rpm: s.rpm || null };
      return renderTimers();
    }
    if ((b = e.target.closest('[data-ted-rpm]'))) {
      TED.rpm = Math.max(600, Math.min(3450, TED.rpm + parseInt(b.dataset.tedRpm, 10)));
      var rb = document.getElementById('ted-rpm'); if (rb) rb.textContent = TED.rpm; return;
    }
    if (e.target.closest('[data-ted-off]')) return saveTimer('00:00', '00:00');
    if (e.target.closest('[data-ted-save]')) {
      var st = (document.getElementById('ted-start') || {}).value, en = (document.getElementById('ted-end') || {}).value;
      if (!/^\d\d:\d\d$/.test(st || '') || !/^\d\d:\d\d$/.test(en || '')) return toast('Choisis une heure de début et de fin', true);
      if (st === en) return toast('Le début et la fin sont identiques : utilise « Désactiver »', true);
      return saveTimer(st, en);
    }
    if ((b = e.target.closest('[data-enstep]'))) return stepEnergy(+b.dataset.enstep);
    if (e.target.closest('[data-recback]')) { REC = null; sheet.dataset.view = 'cams'; sheet.scrollTop = 0; return renderCams(); }
    if ((b = e.target.closest('[data-recday]'))) { REC.date = b.dataset.recday; REC.list = null; return loadRec(); }
    if ((b = e.target.closest('[data-evplay]'))) return playEvent(b.dataset.evplay);
    if ((b = e.target.closest('[data-recplay]'))) {
      var r = REC && REC.list && REC.list[+b.dataset.recplay]; if (!r) return;
      var label = r.begin.slice(11, 16) + ' → ' + r.end.slice(11, 16) + ' · ' + new Date(r.begin.replace(' ', 'T')).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
      b.classList.add('busy');
      return api({ action: 'im.playback', cam: REC.cam, begin: r.begin, end: r.end }).then(function (j) {
        REC.play = { url: j.url, label: label, key: r.begin }; sheet.scrollTop = 0; renderRec();
      }).catch(function () { b.classList.remove('busy'); toast('Lecture impossible pour le moment, réessaie', true); });
    }
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
    render(); refresh(); refreshHeating(); refreshTuya(true); refreshIq(false);
    setInterval(function () { if (!document.hidden) refreshIq(false); }, 60000);
    setInterval(function () { if (!document.hidden) refresh(); }, 10000);
    setInterval(function () { if (!document.hidden && !ntPend) refreshHeating(); }, 30000);
    setInterval(function () { if (!document.hidden) refreshTuya(); }, 30000);
    setInterval(function () { if (!document.hidden && lastOk && !busy()) render(); }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh(); refreshHeating(); refreshTuya(true); } });
  }).catch(function () { app.innerHTML = '<div class="setup"><h1>Maison</h1><p>Impossible de charger la configuration. Vérifie ta connexion.</p></div>'; });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
