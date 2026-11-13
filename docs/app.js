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
  var tabsEl = document.getElementById('tabs');
  var TAB = store.get('maison.tab') || 'home';
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
  function busy() { return document.querySelector('.confirming, .armed-confirm, .slide.dragging') || (TAB === 'cams' && document.querySelector('#app video') && allCams().map(function (c) { return c.id; }).join(',') === camsSig); }

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
      (x.aux1 != null ? '<button class="ctl tog wide' + (iqVal('exo', 'aux1', x.aux1) ? ' is-on light' : '') + '" data-iq-tog="exo:aux1"' + (off ? ' disabled' : '') + '><small>' + icon('bulb') + 'Éclairage piscine</small><span class="sw"></span></button>' : '') +
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
      '<button class="ctl tog' + (on ? ' is-on heat' : '') + '" data-iq-tog="hp:on"' + (off ? ' disabled' : '') + '><small data-label>' + (off ? 'Dernier état : ' + (on ? 'marche' : 'arrêt') : on ? 'En marche' : 'Arrêtée') + '</small><span class="sw"></span></button>' +
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
        '<button class="act" data-slideopen="garage:item-garage">Ouvrir / fermer</button></span></div>' + slideHTML('item-garage');
    }
    if (it.type === 'action') {
      return '<div class="row"><span class="ic">' + icon(it.icon || 'home') + '</span><span><b>' + esc(it.name) + '</b><small>' + (STATES[id] ? esc(STATES[id].text) : '') + '</small></span>' +
        (it.confirm ? '<button class="act" data-slideopen="gate:item-' + id + '">' + esc(it.label || 'OK') + '</button></div>' + slideHTML('item-' + id)
          : '<button class="act" data-action="' + id + '" data-v="' + esc(it.value) + '" data-msg="' + esc(it.name) + ' : envoyé">' + esc(it.label || 'OK') + '</button></div>');
    }
    if (it.type === 'yesno') {
      var yes = num(id) === 1;
      return '<button class="row' + (yes ? ' is-on yes' : '') + (pending[id] ? ' busy' : '') + '" data-yesno="' + id + '"><span class="ic">' + icon(it.icon || (CFG.alarm && CFG.alarm.items.indexOf(it) >= 0 ? 'shield' : 'blind')) + '</span>' +
        '<span><b>' + esc(it.name) + '</b><small>' + esc((yes ? 'Oui' : 'Non') + (it.sub ? ' · ' + it.sub : '') + (since(id) ? ' · ' + since(id) : '')) + '</small></span><span class="sw"></span></button>';
    }
    if (it.type === 'choice') {
      var cv = val(id);
      return '<div class="row choice"><span class="ic">' + icon(it.icon || 'gear') + '</span><span><b>' + esc(it.name) + '</b><small>' + esc((it.sub ? it.sub + ' · ' : '') + since(id)) + '</small></span><span></span>' +
        '<div class="chs">' + it.options.map(function (o) { return '<button class="' + (String(o[0]) === cv ? 'on' : '') + '" data-choice="' + id + ':' + o[0] + '">' + esc(o[1]) + '</button>'; }).join('') + '</div></div>';
    }
    if (it.type === 'motion') {
      var mv = num(id) > 0, ch = STATES[id] && STATES[id].changed ? new Date(STATES[id].changed.replace(' ', 'T')).getTime() : null;
      var old = ch && Date.now() - ch > 14 * 86400000;
      var ago2 = ch ? since(id).replace('depuis ', 'il y a ') : ''; // « à 09h04 · il y a 36 min »
      return '<div class="row motion' + (mv ? ' mv' : '') + (old ? ' old' : '') + '"><span class="ic">' + icon('walk') + '</span><span><b>' + esc(it.name) + '</b><small>' +
        esc(mv ? 'Mouvement détecté ' + since(id) : old ? 'Dernier signal ' + since(id) + ' · pile à vérifier ?' : 'Dernier passage ' + ago2) + '</small></span>' +
        '<span class="mvdot">' + (mv ? 'Mouvement' : old ? 'Inactif ?' : 'Calme') + '</span></div>';
    }
    if (it.type === 'state') {
      var stx = STATES[id] ? STATES[id].text : '—', act = num(id) > 0;
      return '<div class="row"><span class="ic">' + icon(it.icon || 'shield') + '</span><span><b>' + esc(it.name) + '</b><small>' + esc(since(id)) + '</small></span><span class="' + (act ? 'bad' : 'ok') + '">' + esc(stx) + '</span></div>';
    }
    if (it.type === 'iaqua-exo') return poolExoHTML(it);
    if (it.type === 'iaqua-hp') return poolHpHTML(it);
    if (it.type === 'tuya-switch') {
      var d = tuDev(it.key), son = tuOn(it.key);
      var sub = !d ? 'Chargement…' : son ? 'Allumé' + (d.power > 5 ? ' · chauffe ' + watts(d.power) : '') : 'Éteint';
      return '<button class="row' + (son ? ' is-on heat' : '') + (tuPend[it.key] ? ' busy' : '') + '"' + (son ? ' data-tuya="' + esc(it.key) + '"' : ' data-slideopen="sauna-on:item-' + esc(it.key) + '"') + '>' +
        '<span class="ic">' + icon(it.icon || 'flame') + '</span><span><b>' + esc(it.name) + '</b><small data-label>' + esc(sub) + '</small></span><span class="sw"></span></button>' + slideHTML('item-' + it.key);
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

      '<div class="rchips">' + chips + '</div>' +
      '<div class="modes">' +
      '<button class="' + (homeMode === 'schedule' ? 'on' : '') + '" data-nt-mode="schedule">Planning</button>' +
      '<button class="' + (homeMode === 'away' ? 'on' : '') + '" data-nt-mode="away"><span>Absent</span></button>' +
      '<button class="' + (homeMode === 'hg' ? 'on' : '') + '" data-nt-mode="hg"><span>Hors-gel</span></button></div>' +
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
      }).join('') + '<button class="manage" data-plans>' + icon('gear') + 'Gérer les plannings</button></div>';
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

  // ---------- Glisser pour confirmer ----------
  // SLIDE = { key, where } : curseur affiché sous une tuile ou une ligne. Clés : gate, garage-1, garage-2, alarm-on, alarm-off, sauna-on
  var SLIDE = null, slideT = null;
  var SLIDE_LABEL = {
    gate: 'Glisser pour actionner le portail', garage: 'Ouvrir / fermer la porte de garage', 'garage-1': 'Glisser pour ouvrir le garage', 'garage-2': 'Glisser pour fermer le garage',
    'alarm-on': "Glisser pour activer l'alarme", 'alarm-off': "Glisser pour désactiver l'alarme", 'sauna-on': 'Glisser pour allumer le sauna'
  };
  function openSlide(key, where) {
    SLIDE = SLIDE && SLIDE.key === key && SLIDE.where === where ? null : { key: key, where: where };
    clearTimeout(slideT); if (SLIDE) slideT = setTimeout(function () { SLIDE = null; if (!busy()) render(); }, 15000);
    render();
  }
  function slideHTML(where) {
    if (!SLIDE || SLIDE.where !== where) return '';
    var k = SLIDE.key, garage = false; // plus de choix Ouvrir / Fermer : une seule commande pour la porte de garage
    return '<div class="slidebox">' +
      (garage ? '<div class="seg2"><button class="' + (k === 'garage-1' ? 'on' : '') + '" data-slidekey="garage-1">Ouvrir</button><button class="' + (k === 'garage-2' ? 'on' : '') + '" data-slidekey="garage-2">Fermer</button></div>' : '') +
      '<div class="slide' + (/alarm|sauna/.test(k) ? ' warm' : '') + '" data-slide="' + k + '"><span class="fill"></span><span class="knob">' + icon('chev') + '</span><span class="sl-t">' + esc(SLIDE_LABEL[k]) + '</span></div>' +
      '<button class="sl-x" data-slidex>Annuler</button></div>';
  }
  function doSlide(key) {
    SLIDE = null; clearTimeout(slideT);
    if (key === 'gate') send(CFG.dock.gate, 100, { optimistic: false, msg: 'Portail : commande envoyée' });
    else if (key === 'garage') { send(CFG.dock.garage, 1, { optimistic: false, msg: 'Porte de garage : commande envoyée' }); GAR = { state: 'unknown', date: '', src: 'commande', log: [], cam: GAR && GAR.cam }; setTimeout(function () { if (LOGS.doors) LOGS.doors.at = 0; loadLogs('doors', true); }, 3000); setTimeout(function () { if (LOGS.doors) LOGS.doors.at = 0; loadLogs('doors', true); }, 50000); }
    else if (key === 'garage-1' || key === 'garage-2') { send(CFG.dock.garage, key === 'garage-1' ? 1 : 2, { optimistic: false, msg: key === 'garage-1' ? 'Garage : ouverture envoyée' : 'Garage : fermeture envoyée' }); GAR = { state: 'unknown', date: '', src: 'commande', log: [] }; setTimeout(function () { if (LOGS.doors) LOGS.doors.at = 0; loadLogs('doors', true); }, 3000); }
    else if (key === 'alarm-on' || key === 'alarm-off') send(CFG.status.alarm, key === 'alarm-on' ? 12 : 0, { msg: key === 'alarm-on' ? 'Alarme activée' : 'Alarme désactivée' });
    else if (key === 'sauna-on') saunaSet(true);
    setTimeout(render, 600);
  }
  function saunaSet(want) {
    tuPend.sauna = { on: want, until: Date.now() + 10000 }; render();
    return api({ action: 'tu.switch', key: 'sauna', on: want }).then(function () {
      toast(want ? 'Sauna allumé' : 'Sauna éteint'); setTimeout(function () { refreshTuya(true); }, 2500); setTimeout(function () { refreshTuya(true); }, 8000);
    }).catch(function () { delete tuPend.sauna; render(); toast('Le sauna ne répond pas, réessaie', true); });
  }

  // ---------- Graphiques (historique réel) ----------
  var HISTN = {}, HISTE = {}, ENGT = null, engtAt = 0;
  function loadRoomHist(room) {
    var c = HISTN[room]; if (c && (c.loading || Date.now() - c.at < 600000)) return;
    HISTN[room] = { loading: true, at: Date.now(), points: c ? c.points : null };
    api({ action: 'nt.roomhist', room: room, hours: 24 }).then(function (j) { HISTN[room] = { at: Date.now(), points: j.points }; if (!busy()) render(); })
      .catch(function () { HISTN[room] = { at: Date.now() - 540000, points: c ? c.points : null }; });
  }
  function loadHistE(id, hours) {
    var key = id + '|' + hours, c = HISTE[key]; if (c && (c.loading || Date.now() - c.at < 600000)) return;
    HISTE[key] = { loading: true, at: Date.now(), points: c ? c.points : null };
    api({ action: 'hist', id: id, hours: hours }).then(function (j) { HISTE[key] = { at: Date.now(), points: j.points }; if (!busy()) render(); })
      .catch(function () { HISTE[key] = { at: Date.now() - 540000, points: c ? c.points : null }; });
  }
  function loadEnergyToday() {
    if (Date.now() - engtAt < 300000) return; engtAt = Date.now();
    var keys = ['elec', 'pac', 'sauna'], out = {};
    Promise.all(keys.map(function (k) { return api({ action: 'tu.energy', key: k }).then(function (j) { out[k] = j; }).catch(function () {}); }))
      .then(function () { ENGT = out; if (!busy()) render(); });
  }
  function energyToday() {
    // Somme des 3 appareils, heure par heure, pour aujourd'hui
    if (!ENGT) return null;
    var today = ymd(new Date()).replace(/-/g, ''), hours = [], total = 0, any = false;
    for (var i = 0; i < 24; i++) hours.push(null);
    Object.keys(ENGT).forEach(function (k) {
      (ENGT[k].hours || []).forEach(function (x) { if (x.k.slice(0, 8) === today) { var h = +x.k.slice(8, 10); hours[h] = (hours[h] || 0) + x.kwh; any = true; } });
      (ENGT[k].days || []).forEach(function (x) { if (x.k === today) total += x.kwh; });
    });
    var sumH = hours.reduce(function (s, v) { return s + (v || 0); }, 0);
    return { hours: hours, total: Math.max(total, sumH) };
  }
  function spark(points, o) {
    // points : [[x, y], ...] (x croissant). o : { w, h, ref, color, labels, area }
    o = o || {}; var W = o.w || 300, H = o.h || 70, pad = 4, c = o.color || '#FF8A5B';
    if (!points || points.length < 2) return '<div class="spark-empty">' + (points ? 'Pas encore assez de mesures' : 'Chargement de l\'historique…') + '</div>';
    var xs = points.map(function (p) { return p[0]; }), ys = points.map(function (p) { return p[1]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var all = ys.concat(o.ref != null ? [o.ref] : []), y0 = Math.min.apply(null, all), y1 = Math.max.apply(null, all);
    if (y1 - y0 < 0.6) { var mid = (y0 + y1) / 2; y0 = mid - 0.3; y1 = mid + 0.3; }
    var X = function (v) { return pad + (v - x0) / Math.max(1, x1 - x0) * (W - 2 * pad); }, Y = function (v) { return pad + (1 - (v - y0) / (y1 - y0)) * (H - 2 * pad - 6) + 3; };
    var d = points.map(function (p, i) { return (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join(' ');
    var gid = 'g' + Math.random().toString(36).slice(2, 8), hl = o.labels ? 14 : 0;
    var s = '<svg class="spark" viewBox="0 0 ' + W + ' ' + (H + hl) + '" preserveAspectRatio="none"><defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c + '" stop-opacity=".32"/><stop offset="1" stop-color="' + c + '" stop-opacity="0"/></linearGradient></defs>';
    if (o.ref != null) s += '<line x1="0" x2="' + W + '" y1="' + Y(o.ref).toFixed(1) + '" y2="' + Y(o.ref).toFixed(1) + '" class="sp-ref"/>';
    s += '<path d="' + d + ' L' + X(x1).toFixed(1) + ' ' + H + ' L' + X(x0).toFixed(1) + ' ' + H + ' Z" fill="url(#' + gid + ')"/>';
    s += '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    var last = points[points.length - 1]; s += '<circle cx="' + X(last[0]).toFixed(1) + '" cy="' + Y(last[1]).toFixed(1) + '" r="3.5" fill="' + c + '"/>';
    if (o.labels) o.labels.forEach(function (t, i) { s += '<text x="' + (i / (o.labels.length - 1) * W).toFixed(1) + '" y="' + (H + 11) + '" class="sp-l" text-anchor="' + (i === 0 ? 'start' : i === o.labels.length - 1 ? 'end' : 'middle') + '">' + t + '</text>'; });
    return s + '</svg>';
  }
  function miniBars(vals, o) {
    o = o || {}; var W = o.w || 160, H = o.h || 34, n = vals.length, g = 2, bw = (W - g * (n - 1)) / n;
    var mx = Math.max.apply(null, vals.map(function (v) { return v || 0; }).concat([0.001])), hi = o.hi;
    var s = '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
    vals.forEach(function (v, i) { var h = v == null ? 1.5 : Math.max(2, v / mx * (H - 2)); s += '<rect x="' + (i * (bw + g)).toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1.5" class="' + (v == null ? 'mb-e' : i === hi ? 'mb-h' : 'mb') + '"/>'; });
    return s + '</svg>';
  }
  function schedWhen() {
    if (!NT) return '';
    var s = NT.slot || {};
    if (NT.mode === 'away') return 'Mode Absent';
    if (NT.mode === 'hg') return 'Mode Hors-gel';
    if (s.until) { var dayTxt = s.untilDay === 'today' || s.untilDay === 'week' ? '' : s.untilDay === 'tomorrow' ? 'demain ' : s.untilDay + ' '; return (s.zone ? s.zone + ' ' : '') + "jusqu'à " + dayTxt + s.until; }
    return s.zone || '';
  }

  // ---------- Journaux des 3 derniers jours (présence, alarme, portes) ----------
  var LOGS = {}, GAR = null, logsView = null;
  function loadLogs(kind, quiet) {
    var ttl = kind === 'doors' && GAR && GAR.state === 'unknown' ? 12000 : 120000; // garage à vérifier : on redemande souvent
    if (!LOGS[kind]) { try { var sv = JSON.parse(localStorage.getItem('maison-logs-' + kind) || 'null'); if (sv && sv.events) LOGS[kind] = { at: 0, data: sv }; } catch (e) {} } // dernier journal connu, affiché tout de suite
    var c = LOGS[kind]; if (c && (c.loading || Date.now() - c.at < ttl)) return;
    LOGS[kind] = { loading: true, at: Date.now(), data: c ? c.data : null };
    api({ action: 'logs', kind: kind }).then(function (j) {
      LOGS[kind] = { at: j.partial ? Date.now() - 105000 : Date.now(), data: j }; if (j.garage) GAR = j.garage;
      if (j.garage && j.garage.state !== 'open' && navigator.clearAppBadge) { try { navigator.clearAppBadge(); } catch (e) {} } // pastille effacée dès que la porte n'est plus ouverte // incomplet : on redemande ~15 s plus tard
      if (j.partial) setTimeout(function () { loadLogs(kind, true); }, 16000);
      try { var keep = { events: j.events, kind: j.kind }; localStorage.setItem('maison-logs-' + kind, JSON.stringify(keep)); } catch (e) {}
      if (!busy()) render(); if (logsView === kind && !sheet.hidden) renderLogs();
    }).catch(function () { LOGS[kind] = { at: Date.now() - 90000, data: c ? c.data : null }; if (!quiet) toast('eedomus ne répond pas, réessaie', true); });
  }
  function openLogs(kind) { logsView = kind; sheet.scrollTop = 0; openSheet('logs'); LOGS[kind] && (LOGS[kind].at = 0); loadLogs(kind); if (kind === 'doors') loadImou(false); }
  function dayLabel(d) {
    var dt = new Date(d.replace(' ', 'T')), t0 = new Date(); t0.setHours(0, 0, 0, 0);
    var diff = Math.round((t0 - new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())) / 86400000);
    if (diff <= 0) return "Aujourd'hui"; if (diff === 1) return 'Hier';
    var s = dt.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function personOf(text) { return String(text || '').replace(/\s+(pr[ée]sente?|absente?)$/i, '').replace(/^France$/, 'Françoise'); }
  function logLine(kind, e) {
    if (kind === 'people') {
      var here = /pr[ée]sent/i.test(e.text);
      return { cls: here ? 'ok' : 'mu', ic: here ? 'home' : 'leave', txt: personOf(e.text) + (here ? ' est arrivé' + (/e$/i.test(e.text) ? 'e' : '') : ' est parti' + (/e$/i.test(e.text) ? 'e' : '')) };
    }
    if (kind === 'alarm') {
      var on = /activ[ée]e$/i.test(e.text) && !/d[ée]sactiv/i.test(e.text), bad = /sir[eè]ne|intrusion/i.test(e.text);
      return { cls: bad ? 'bad' : on ? 'ok' : 'mu', ic: 'shield', txt: 'Alarme ' + e.text.toLowerCase() };
    }
    var open = /ouvert|ouverture/i.test(e.text), isGar = /garage/i.test(e.name);
    return { cls: open ? 'warnc' : 'mu', ic: isGar ? 'garage' : /portail/i.test(e.name) ? 'gate' : 'door', txt: isGar ? 'Garage : commande ' + e.text.toLowerCase() : e.name + ' ' + e.text.toLowerCase() };
  }
  function renderLogs() {
    var kind = logsView, L = LOGS[kind], d = L && L.data;
    var title = { people: 'Présence', alarm: 'Alarme', doors: 'Portes' }[kind];
    var h = '<div class="sh-hd"><h2>' + title + '</h2><button class="close" data-close aria-label="Fermer">×</button></div>';
    // État actuel
    if (kind === 'people') {
      h += '<div class="card2 flat rs-list">' + CFG.status.people.map(function (id) {
        var st = STATES[id] || {}, here = st.value !== undefined && st.value !== '0';
        return '<div class="row"><span class="ic' + (here ? ' okc' : '') + '">' + icon(here ? 'home' : 'leave') + '</span><span><b>' + esc(personOf(st.text) || '—') + '</b><small>' + esc(since(id)) + '</small></span><span class="' + (here ? 'ok' : 'mu2') + '">' + (here ? 'Présent' : 'Absent') + '</span></div>';
      }).join('') + '</div>';
    } else if (kind === 'alarm') {
      var av = num(CFG.status.alarm), ast = (STATES[CFG.status.alarm] || {}).text || '—';
      h += '<div class="acard ' + (av ? 'ok' : '') + '"><span class="aic">' + icon('shield') + '</span><span><b>Alarme ' + esc(ast.toLowerCase()) + '</b><small>' + esc(since(CFG.status.alarm)) + '</small></span></div>';
    } else {
      var rows = CFG.status.doors.map(function (id) {
        var it = findItem(id) || { name: 'Porte' }, o = doorOpen(id);
        return '<div class="row"><span class="ic">' + icon('door') + '</span><span><b>' + esc(it.name) + '</b><small>' + esc(since(id)) + '</small></span><span class="' + (o ? 'bad' : 'ok') + '">' + (o ? 'Ouverte' : 'Fermée') + '</span></div>';
      });
      var g = STATES[CFG.dock.gate] || {}, go = g.value !== undefined && g.value !== '0';
      rows.push('<div class="row"><span class="ic">' + icon('gate') + '</span><span><b>Portail</b><small>' + esc(since(CFG.dock.gate)) + '</small></span><span class="' + (go ? 'bad' : 'ok') + '">' + esc(g.text || '—') + '</span></div>');
      var go2 = GAR && GAR.state === 'open';
      var src = GAR ? { commande: 'commande envoyée, état à confirmer', manuel: 'confirmé à la main', camera: 'vu par la caméra', 'défaut': 'état par défaut' }[GAR.src] || '' : '';
      var gu = GAR && GAR.state === 'unknown';
      rows.push('<div class="row"><span class="ic">' + icon('garage') + '</span><span><b>Porte de garage</b><small>' + esc((GAR && GAR.date ? sinceDate(GAR.date) + ' · ' : '') + src) + '</small></span><span class="' + (go2 ? 'bad' : gu ? 'warn2' : 'ok') + '">' + (GAR ? (go2 ? 'Ouverte' : gu ? 'À vérifier' : 'Fermée') : '…') + '</span></div>');
      h += '<div class="card2 flat rs-list">' + rows.join('') + '</div>';
      // Vérification par la caméra du garage
      var gc = IM && IM.cameras ? IM.cameras.filter(function (c) { return norm(c.name) === 'garage'; })[0] : null;
      // Contrôle automatique par la caméra (n8n compare la photo aux références ouverte / fermée)
      var cam = GAR && GAR.cam, camTxt = '';
      if (cam && cam.at) camTxt = 'Dernier contrôle par la caméra à ' + new Date(cam.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + ' : ' +
        (cam.state === 'open' ? 'ouverte' : cam.state === 'closed' ? 'fermée' : 'image pas assez claire') + (cam.err ? ' · caméra en erreur, contrôles ralentis' : cam.today ? ' · ' + cam.today + ' contrôles aujourd’hui' : '');
      var learn = cam && cam.refs ? 'Photos de référence : ' + cam.refs.open + ' ouverte, ' + cam.refs.closed + " fermée. Confirme aussi l'état une fois de nuit pour que la caméra le reconnaisse dans le noir." : '';
      h += '<div class="garcheck"><div class="gc-hd"><b>Vérifier la porte de garage</b><small>' + esc(camTxt || 'La caméra contrôle la porte toutes les 2 minutes et juste après chaque commande.') + '</small></div>' +
        (gc && gc.snapshot ? '<button class="gc-img" data-opencams="' + esc(gc.id) + '"><img alt="Caméra du garage" src="' + esc(gc.snapshot) + '"><span>Voir en direct ›</span></button>' : '<p class="muted">Photo de la caméra en cours de chargement…</p>') +
        (learn ? '<small class="gc-learn">' + esc(learn) + '</small>' : '') +
        '<div class="gc-btns"><button class="act' + (go2 ? ' on' : '') + '" data-garmark="open">Elle est ouverte</button><button class="act' + (GAR && !go2 ? ' on' : '') + '" data-garmark="closed">Elle est fermée</button></div></div>';
    }
    // Journal
    h += '<div class="lbl" style="margin-left:4px">3 derniers jours</div>';
    if (!d) h += '<p class="muted">Lecture de l\'historique eedomus…</p>';
    else {
      var evs = d.events.filter(function (e) { return !(kind === 'doors' && /en attente/i.test(e.text)); });
      if (d.partial) h += '<p class="muted">eedomus n’a pas tout envoyé, nouvel essai dans quelques secondes…</p>';
      else if (!evs.length) h += '<p class="muted">Aucun changement sur les 3 derniers jours.</p>';
      var cur = '';
      evs.forEach(function (e) {
        var dl = dayLabel(e.date); if (dl !== cur) { if (cur) h += '</div>'; h += '<div class="lday">' + esc(dl) + '</div><div class="card2 flat logs">'; cur = dl; }
        var l = logLine(kind, e);
        h += '<div class="lg ' + l.cls + '"><span class="lt">' + esc(e.date.slice(11, 16)) + '</span><span class="li">' + icon(l.ic) + '</span><span>' + esc(l.txt) + '</span></div>';
      });
      if (cur) h += '</div>';
    }
    var keep = sheet.scrollTop; sheet.innerHTML = '<div class="sh-in">' + h + '</div>'; sheet.scrollTop = keep;
  }

  // ---------- Onglet Accueil ----------
  function homeHTML() {
    var s = CFG.status, armed = alarmArmed();
    var n = s.people.filter(function (id) { var v = val(id); return v !== undefined && v !== '0'; }).length;
    var gate = STATES[CFG.dock.gate] || {}, gateOpen = gate.value !== undefined && gate.value !== '0';
    var openDoors = s.doors.filter(doorOpen).length;
    loadLogs('doors', true);
    var garOpen = GAR && GAR.state === 'open', garUnk = GAR && GAR.state === 'unknown';
    var closed = !openDoors && !gateOpen && !garOpen && !garUnk;
    var what = gateOpen ? 'Portail ouvert' : garOpen ? 'Garage ouvert' : garUnk && !openDoors ? 'Garage à vérifier' : openDoors + ' porte' + (openDoors > 1 ? 's' : '') + ' ouverte' + (openDoors > 1 ? 's' : '');
    var h = '<div class="status"><button class="' + (closed ? 'ok' : 'bad') + '" data-logs="doors">● ' + (closed ? 'Tout est fermé' : what) + '</button>' +
      '<button class="' + (armed ? 'ok' : '') + '" data-logs="alarm">' + icon('shield') + (armed ? 'Alarme activée' : 'Alarme désactivée') + '</button>' +
      '<button data-logs="people">' + icon(n ? 'home' : 'leave') + (n ? n + ' personne' + (n > 1 ? 's' : '') : 'Personne') + '</button></div>';
    // Chauffage
    var r = ntCurrentRoom();
    if (r) {
      loadRoomHist(r.id);
      var sp = ntPend && String(ntPend.room) === String(r.id) ? ntPend.temp : r.setpoint, hp = HISTN[r.id];
      h += '<div class="hcard"><button class="hc-top" data-graph="' + esc(r.id) + '"><span>Chauffage · ' + esc(r.name) + '</span><span class="' + (r.heating ? 'heat' : 'mu') + '">' + icon('flame') + (r.heating ? 'Chauffe' : NT.boiler ? 'Chaudière en marche' : 'Au repos') + '</span></button>' +
        '<button class="hc-mid" data-graph="' + esc(r.id) + '"><div class="big">' + fmt(r.temp, 1) + '°<em id="ntsp">Consigne ' + fmt(sp, 1) + '°</em></div>' +
        '<div class="hc-sp">' + spark(hp && hp.points ? hp.points : null, { w: 180, h: 60, ref: sp }) + '</div></button>' + manualHTML(r) +
        '<div class="hc-plan"><span><b>' + esc(NT.schedule || 'Planning') + '</b> · ' + esc(schedWhen()) + '</span>' +
        '<span class="stp2"><button data-nt-step="-0.5" aria-label="Baisser">−</button><button data-nt-step="0.5" aria-label="Monter">+</button></span></div></div>';
    } else {
      h += '<div class="hcard"><div class="hc-top"><span>Chauffage</span><span class="mu">' + (ntErr ? 'Netatmo indisponible' : 'Connexion…') + '</span></div></div>';
    }
    // Accès rapide
    var sd = tuDev('sauna'), son = tuOn('sauna'), gar = STATES[CFG.dock.garage] || {};
    var tile = function (k, ic, name, st, on) {
      return '<button class="q' + (on ? ' on' : '') + (SLIDE && SLIDE.where === 'home' && SLIDE.key.indexOf(k) === 0 ? ' sel' : '') + '" data-qa="' + k + '"><span class="ic">' + icon(ic) + '</span>' + name + '<small>' + esc(st) + '</small></button>';
    };
    h += '<div class="lbl">Accès rapide</div><div class="quick">' +
      tile('gate', 'gate', 'Portail', gate.text || '—', gateOpen) +
      tile('garage', 'garage', 'Garage', GAR ? (GAR.state === 'open' ? 'Ouverte' : GAR.state === 'closed' ? 'Fermée' : 'À vérifier') : '…', GAR && GAR.state === 'open') +
      tile('sauna', 'flame', 'Sauna', !sd ? '…' : son ? (sd.power > 50 ? watts(sd.power) : 'Allumé') : 'Éteint', son) +
      tile('alarm', 'shield', 'Alarme', armed ? 'Activée' : 'Off', armed) +
      '</div>' + slideHTML('home');
    // Favoris
    var salon = findRoom('salon'), lit = salon ? salon.items.filter(function (it) { return it.type === 'light' && isOn(it); }).length : 0;
    var shut = [], allRooms = [];
    CFG.groups.forEach(function (g) { g.rooms.forEach(function (rm) { allRooms.push(rm); rm.items.forEach(function (it) { if (it.type === 'shutter') shut.push(it); }); }); });
    var up = shut.filter(function (i) { return shutterPos(i.id) === 'up'; }).length;
    loadHistE(3557564, 168); loadEnergyToday();
    var ex = IQ && IQ.exo, ph = ex && ex.ph != null ? ex.ph : num(3557564), water = ex && ex.water != null ? ex.water : num(3557562);
    var et = energyToday(), hi = new Date().getHours();
    h += '<div class="lbl">Favoris</div><div class="fav">' +
      '<button class="fv' + (lit ? ' lit' : '') + '" data-goroom="salon">' + icon('bulb') + '<b>Salon</b><small>' + (lit ? lit + ' lumière' + (lit > 1 ? 's' : '') + ' allumée' + (lit > 1 ? 's' : '') : 'Lumières éteintes') + '</small></button>' +
      '<button class="fv" data-goroom="volets">' + icon('blind') + '<b>Volets</b><small>' + (up === 0 ? 'Tous fermés' : up === shut.length ? 'Tous ouverts' : up + ' / ' + shut.length + ' ouverts') + '</small></button>' +
      '<button class="fv" data-goto="more"><span class="fv-hd"><b>Piscine</b><span class="mono">' + (water != null ? fmt(water, 0) + '°' : '') + '</span></span>' +
      '<span class="fv-big">pH ' + fmt(ph, 1) + '</span>' +
      '<small>' + (ph != null ? (ph >= 7.0 && ph <= 7.6 ? 'Idéal' : 'À surveiller') : '') + (ex && ex.swc != null ? ' · chloration ' + ex.swc + ' %' : '') + '</small></button>' +
      '<button class="fv" data-goto="more"><span class="fv-hd"><b>Énergie</b><span class="mono">' + (et ? fmt(et.total, 1) + ' kWh' : '') + '</span></span>' +
      (et ? miniBars(et.hours, { w: 140, h: 30, hi: hi }) : '<div class="spark-empty">Chargement…</div>') + '<small>piscine + sauna, aujourd\'hui</small></button>' +
      '</div>';
    return h;
  }
  function findRoom(id) { var f = null; CFG.groups.forEach(function (g) { g.rooms.forEach(function (r) { if (r.id === id) f = r; }); }); return f; }

  // Consigne manuelle : bien visible, avec un bouton pour revenir au planning
  function manualHTML(r) {
    if (!r || (r.mode !== 'manual' && r.mode !== 'max')) return '';
    return '<div class="manual"><span>' + icon('hand') + '<b>' + (r.mode === 'max' ? 'Boost' : 'Manuel') + ' ' + fmt(r.setpoint, 1) + '°</b>' +
      (r.end ? " jusqu'à " + hhmm(r.end) : '') + '</span><button data-nt-homeroom="' + esc(r.id) + '">' + icon('x') + 'Retirer</button></div>';
  }
  function resetRoom(id) {
    var rm = (NT.rooms || []).filter(function (x) { return String(x.id) === String(id); })[0];
    toast('Retour au planning…');
    return api({ action: 'nt.setpoint', room: id, mode: 'home' }).then(function (j) { NT = j; render(); toast((rm ? rm.name : 'Pièce') + ' : retour au planning'); })
      .catch(function () { toast('Netatmo ne répond pas, réessaie', true); });
  }

  // ---------- Graphique détaillé d'une pièce (comme l'appli Netatmo) ----------
  var GR = null; // { room, range, end, data, idx, loading }
  var GR_RANGES = [['6h', '6H', 6 * 3600], ['1d', '1J', 86400], ['1w', '1S', 7 * 86400], ['1m', '1M', 30 * 86400], ['1y', '1A', 365 * 86400]];
  function openGraph(room) { GR = { room: String(room), range: '1d', end: null, data: null, idx: null }; sheet.scrollTop = 0; openSheet('graph'); loadGraph(); }
  function loadGraph() {
    if (!GR) return; var g = GR, want = g.room + '|' + g.range + '|' + g.end;
    g.loading = true; renderGraph();
    api({ action: 'nt.roomgraph', room: g.room, range: g.range, end: g.end || undefined }).then(function (j) {
      if (!GR || GR.room + '|' + GR.range + '|' + GR.end !== want) return;
      GR.data = j; GR.idx = null; GR.loading = false; renderGraph();
    }).catch(function () { if (GR) { GR.loading = false; GR.error = true; renderGraph(); } });
  }
  function graphSVG(d, idx) {
    if (!d) return '<p class="muted">Chargement…</p>';
    var rows = (d.rows || []).filter(function (r) { return r[1] != null; });
    if (rows.length < 2) return '<div class="spark-empty">Pas de mesures sur cette période.</div>';
    var W = 340, H = 300, L = 30, R = 8, T = 18, B = 22, x0 = d.begin, x1 = d.end;
    var temps = [], sps = [];
    rows.forEach(function (r) { temps.push(r[1]); if (r[2] != null) sps.push(r[2]); });
    var lo = Math.floor(Math.min.apply(null, temps.concat(sps)) - 0.5), hi = Math.ceil(Math.max.apply(null, temps.concat(sps)) + 0.5);
    if (hi - lo < 4) { hi = lo + 4; }
    var bandH = (H - T - B) * 0.28, X = function (t) { return L + (t - x0) / (x1 - x0) * (W - L - R); }, Y = function (v) { return T + (1 - (v - lo) / (hi - lo)) * (H - T - B); };
    var s = '<svg class="gsvg" viewBox="0 0 ' + W + ' ' + H + '" data-gsvg>';
    for (var v = lo; v <= hi; v++) s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '" class="g-grid"/><text x="' + (L - 6) + '" y="' + (Y(v) + 3).toFixed(1) + '" class="g-yl" text-anchor="end">' + v + '</text>';
    // % de chauffe (barres orange en bas)
    var step = rows.length > 1 ? (X(rows[1][0]) - X(rows[0][0])) : 6, bw = Math.max(1.5, step * 0.6);
    rows.forEach(function (r) { if (r[3] > 0) { var hh = r[3] / 100 * bandH; s += '<rect x="' + (X(r[0]) - bw / 2).toFixed(1) + '" y="' + (H - B - hh).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hh.toFixed(1) + '" rx="1" class="g-heat"/>'; } });
    // consigne (escalier rouge)
    var sp = rows.filter(function (r) { return r[2] != null; });
    if (sp.length) {
      var dp = 'M' + X(sp[0][0]).toFixed(1) + ' ' + Y(sp[0][2]).toFixed(1);
      for (var i = 1; i < sp.length; i++) dp += ' H' + X(sp[i][0]).toFixed(1) + ' V' + Y(sp[i][2]).toFixed(1);
      s += '<path d="' + dp + '" class="g-sp"/>';
    }
    // température (courbe bleue)
    var dt = rows.map(function (r, i) { return (i ? 'L' : 'M') + X(r[0]).toFixed(1) + ' ' + Y(r[1]).toFixed(1); }).join(' ');
    s += '<path d="' + dt + '" class="g-t"/>';
    // axe des temps
    var span = x1 - x0, ticks = span <= 6 * 3600 ? 6 : span <= 86400 ? 6 : span <= 8 * 86400 ? 7 : span <= 31 * 86400 ? 5 : 6;
    for (var k = 0; k <= ticks; k++) {
      var t = x0 + span * k / ticks, dd = new Date(t * 1000), lab;
      if (span <= 86400) lab = String(dd.getHours()).padStart(2, '0') + 'h';
      else if (span <= 8 * 86400) lab = dd.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
      else if (span <= 31 * 86400) lab = dd.getDate() + '/' + (dd.getMonth() + 1);
      else lab = dd.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '');
      s += '<text x="' + X(t).toFixed(1) + '" y="' + (H - 6) + '" class="g-xl" text-anchor="' + (k === 0 ? 'start' : k === ticks ? 'end' : 'middle') + '">' + lab + '</text>';
    }
    // curseur
    var c = rows[idx == null ? rows.length - 1 : idx];
    if (c) {
      s += '<line x1="' + X(c[0]).toFixed(1) + '" x2="' + X(c[0]).toFixed(1) + '" y1="' + (T - 10) + '" y2="' + (H - B) + '" class="g-cur"/>';
      s += '<text x="' + X(c[0]).toFixed(1) + '" y="' + (T - 10) + '" class="g-xl" text-anchor="' + (X(c[0]) > W - 40 ? 'end' : 'middle') + '">' + new Date(c[0] * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + '</text>';
      if (c[2] != null) s += '<circle cx="' + X(c[0]).toFixed(1) + '" cy="' + Y(c[2]).toFixed(1) + '" r="5" class="g-dsp"/>';
      s += '<circle cx="' + X(c[0]).toFixed(1) + '" cy="' + Y(c[1]).toFixed(1) + '" r="5" class="g-dt"/>';
    }
    return s + '</svg>';
  }
  function renderGraph() {
    if (!GR) return;
    var rm = NT && (NT.rooms || []).filter(function (x) { return String(x.id) === GR.room; })[0];
    var h = '<div class="sh-hd"><h2>' + esc(rm ? rm.name : 'Pièce') + '</h2><button class="close" data-close aria-label="Fermer">×</button></div>';
    h += '<div class="en-tabs g5">' + GR_RANGES.map(function (r) { return '<button class="' + (GR.range === r[0] ? 'on' : '') + '" data-grange="' + r[0] + '">' + r[1] + '</button>'; }).join('') + '</div>';
    var span = GR_RANGES.filter(function (r) { return r[0] === GR.range; })[0][2], endT = GR.end || Math.floor(Date.now() / 1000), begT = endT - span;
    var fmtD = function (t) { return new Date(t * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: span > 86400 * 40 ? 'numeric' : undefined }); };
    h += '<div class="gnav"><button data-gstep="-1" aria-label="Période précédente">' + icon('down') + '</button><span>' + (span <= 86400 ? fmtD(endT) : fmtD(begT) + ' – ' + fmtD(endT)) + '</span>' +
      '<button data-gstep="1" aria-label="Période suivante"' + (GR.end ? '' : ' disabled') + '>' + icon('down') + '</button></div>';
    var d = GR.data, rows = d ? (d.rows || []).filter(function (r) { return r[1] != null; }) : [], c = rows.length ? rows[GR.idx == null ? rows.length - 1 : GR.idx] : null;
    h += '<div class="glegend"><div class="gl t"><b>' + (c ? fmt(c[1], 1) + ' °C' : '—') + '</b><small>Température</small></div>' +
      '<div class="gl s"><b>' + (c && c[2] != null ? fmt(c[2], 1) + ' °C' : '—') + '</b><small>Consigne</small></div>' +
      '<div class="gl c"><b>' + (c && c[3] != null ? c[3] + ' %' : '—') + '</b><small>Chauffage</small></div></div>';
    h += '<div class="gwrap">' + (GR.loading && !d ? '<p class="muted">Chargement…</p>' : GR.error && !d ? '<p class="muted">Netatmo ne répond pas, réessaie.</p>' : graphSVG(d, GR.idx)) + '</div>';
    h += '<p class="note-q">Touche ou fais glisser ton doigt sur le graphique pour lire les valeurs à un moment précis.</p>';
    if (NT && NT.rooms) h += '<div class="rchips gch">' + NT.rooms.map(function (x) { return '<button class="rchip' + (String(x.id) === GR.room ? ' on' : '') + '" data-groom="' + esc(x.id) + '">' + esc(x.name) + '</button>'; }).join('') + '</div>';
    var keep = sheet.scrollTop; sheet.innerHTML = '<div class="sh-in">' + h + '</div>'; sheet.scrollTop = keep;
  }
  function graphPick(e) {
    var svg = e.target.closest('[data-gsvg]'); if (!svg || !GR || !GR.data) return;
    var rows = (GR.data.rows || []).filter(function (r) { return r[1] != null; }); if (!rows.length) return;
    var rc = svg.getBoundingClientRect(), x = (e.clientX - rc.left) / rc.width * 340, L = 30, R = 8;
    var t = GR.data.begin + (x - L) / (340 - L - R) * (GR.data.end - GR.data.begin), best = 0, bd = Infinity;
    rows.forEach(function (r, i) { var dd = Math.abs(r[0] - t); if (dd < bd) { bd = dd; best = i; } });
    if (best !== GR.idx) { GR.idx = best; renderGraph(); }
  }
  sheet.addEventListener('pointerdown', function (e) { if (e.target.closest('[data-gsvg]')) { graphPick(e); sheet._gdrag = true; } });
  sheet.addEventListener('pointermove', function (e) { if (sheet._gdrag) graphPick(e); });
  sheet.addEventListener('pointerup', function () { sheet._gdrag = false; });

  // ---------- Onglet Alarme ----------
  var ALARM_STATE = { 0: ['Désactivée', ''], 12: ['Activée', 'ok'], 13: ['Intrusion détectée', 'bad'], 14: ['Sirène en cours', 'bad'], 5: ['Activation temporisée', 'warnc'] };
  function since(id) { var s = STATES[id]; return s && s.changed ? sinceDate(s.changed) : ''; }
  // « à 09h04 · depuis 36 min » (avec le jour si ce n'est pas aujourd'hui)
  function sinceDate(d) {
    var dt = new Date(String(d).replace(' ', 'T')); if (isNaN(dt)) return '';
    var m = Math.max(0, Math.round((Date.now() - dt.getTime()) / 60000));
    var hm = String(dt.getHours()).padStart(2, '0') + 'h' + String(dt.getMinutes()).padStart(2, '0');
    var t0 = new Date(); t0.setHours(0, 0, 0, 0);
    var days = Math.round((t0 - new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())) / 86400000);
    var when = days <= 0 ? 'à ' + hm : days === 1 ? 'hier à ' + hm : 'le ' + dt.getDate() + '/' + String(dt.getMonth() + 1).padStart(2, '0') + ' à ' + hm;
    if (days > 0) return when; // pas aujourd'hui : juste le jour et l'heure, sans durée
    var dur;
    if (m < 60) dur = m + ' min';
    else if (m < 48 * 60) { var hh = Math.floor(m / 60), mm = m % 60; dur = hh + ' h' + (hh < 10 && mm ? ' ' + String(mm).padStart(2, '0') : ''); }
    else { var dd = Math.round(m / 1440); dur = dd < 60 ? dd + ' jours' : Math.round(dd / 30) + ' mois'; }
    return when + ' · depuis ' + dur;
  }
  function alarmHTML() {
    var A = CFG.alarm || { items: [] }, v = num(A.status), st = ALARM_STATE[v] || [(STATES[A.status] || {}).text || '—', ''], armed = v != null && v !== 0;
    var h = '<div class="acard ' + st[1] + '"><span class="aic">' + icon('shield') + '</span><span><b>Alarme ' + esc(st[0].toLowerCase()) + '</b><small>' + esc(since(A.status)) + '</small></span></div>';
    SLIDE = SLIDE && SLIDE.where === 'alarmtab' ? SLIDE : { key: armed ? 'alarm-off' : 'alarm-on', where: 'alarmtab' };
    SLIDE.key = armed ? 'alarm-off' : 'alarm-on';
    h += slideHTML('alarmtab').replace('<button class="sl-x" data-slidex>Annuler</button>', '');
    var grp = function (g, title) {
      var items = A.items.filter(function (it) { return it.group === g; }); if (!items.length) return '';
      return '<div class="lbl">' + title + '</div><div class="card2 flat">' + items.map(rowHTML).join('') + '</div>';
    };
    h += grp('mode', 'Paramétrage') + grp('zones', 'Zones surveillées') + grp('motion', 'Détecteurs de mouvement');
    h += '<p class="note-q">Les réglages s\'appliquent tout de suite. Seule l\'activation de l\'alarme demande de glisser le bouton.</p>';
    return h;
  }

  // ---------- Onglet Climat ----------
  function climateHTML() {
    var h = heroHTML();
    var r = ntCurrentRoom();
    if (r) {
      loadRoomHist(r.id);
      var hp = HISTN[r.id], sp = ntPend && String(ntPend.room) === String(r.id) ? ntPend.temp : r.setpoint;
      h += manualHTML(r).replace('class="manual"', 'class="manual big"');
      h += '<div class="lbl">Température · ' + esc(r.name) + ' · 24 h</div><button class="card2 gtap" data-graph="' + esc(r.id) + '">' +
        spark(hp && hp.points ? hp.points : null, { w: 320, h: 90, ref: sp, labels: ['−24 h', '−18 h', '−12 h', '−6 h', 'maint.'] }) +
        '<div class="legend"><span><i style="background:#FF8A5B"></i>Mesurée</span><span><i class="dash"></i>Consigne ' + fmt(sp, 1) + '°</span><span class="more">Détails ›</span></div></button>';
      h += '<div class="lbl">Toutes les pièces</div><div class="card2 rooms2">' + NT.rooms.map(function (x) {
        var man = x.mode === 'manual' || x.mode === 'max';
        return '<div class="r2' + (x.id === r.id ? ' on' : '') + '"><button class="r2-b" data-ntroom="' + esc(x.id) + '"><span>' + (x.heating ? icon('flame') : '') + esc(x.name) + (man ? '<i class="mtag">manuel</i>' : '') + '</span>' +
          '<span class="mono">' + fmt(x.temp, 1) + '° <small>→ ' + fmt(x.setpoint, 1) + '°</small></span></button>' + (man ? '<button class="r2-x" data-nt-homeroom="' + esc(x.id) + '" aria-label="Retirer la consigne manuelle">' + icon('x') + '</button>' : '') + '</div>';
      }).join('') + '</div>';
    }
    return h;
  }

  // ---------- Onglet Caméras ----------
  function camsTabHTML() {
    var cams = allCams(), h = '';
    camsSig = cams.map(function (c) { return c.id; }).join(',');
    h += '<button class="autolive' + (autoLive ? ' on' : '') + '" data-autolive><span><b>Tout en direct</b><small>' + (autoLive ? 'Les caméras démarrent seules (Imou en SD pour économiser le forfait)' : 'Touche une caméra pour la voir en direct') + '</small></span><span class="sw"></span></button>';
    h += cams.map(camCardHTML).join('');
    if (!CAMS || !IM) h += '<p class="muted">Chargement des caméras…</p>';
    if (IM && IM.error) h += '<p class="muted">Caméras Imou indisponibles pour le moment.</p>';
    // Les clips de Presence sont dans « Enregistrements », comme pour les autres caméras
    return h;
  }

  // ---------- Onglet Plus (piscine, énergie, météo, réglages) ----------
  function moreHTML() {
    var pis = findRoom('piscine'), met = findRoom('meteo'), sdb = findRoom('sdb'), h = '';
    var ph = HISTE['3557564|168'];
    h += '<div class="lbl">Piscine</div>';
    h += pis.items.filter(function (it) { return /^iaqua-/.test(it.type); }).map(rowHTML).join('');
    h += '<div class="card2"><div class="row-hd"><b>pH · sonde Ondilo · 7 jours</b><span class="mono">' + fmt(num(3557564), 2) + '</span></div>' +
      spark(ph && ph.points ? ph.points.map(function (p) { return [new Date(String(p[0]).replace(' ', 'T')).getTime(), p[1]]; }) : null, { w: 320, h: 70, ref: 7.2, color: '#7CB2FF', labels: ['−7 j', '−5 j', '−3 j', '−1 j', 'auj.'] }) +
      '<div class="acc2b">' + pis.items.filter(function (it) { return it.type === 'sensor' || it.type === 'light'; }).map(rowHTML).join('') + '</div></div>';
    h += '<div class="lbl">Énergie</div><div class="card2 flat">' +
      '<button class="row" data-cost><span class="ic" style="color:#FF8A5B">' + icon('flame') + '</span><span><b>Coût de l’énergie</b><small>Gaz et électricité · estimation en €</small></span><span class="val">›</span></button>' +
      pis.items.filter(function (it) { return it.type === 'tuya-meter'; }).map(rowHTML).join('') +
      sdb.items.filter(function (it) { return it.type === 'tuya-meter'; }).map(rowHTML).join('') + '</div>';
    if (met) h += '<div class="lbl">Météo</div><div class="card2 flat">' + met.items.map(rowHTML).join('') + '</div>';
    h += '<div class="lbl">Application</div><div class="card2 flat">' +
      '<button class="row" data-settings><span class="ic">' + icon('gear') + '</span><span><b>Réglages et nouveautés</b><small>Version ' + esc(LOG ? LOG.version : '…') + (newVersion ? ' · nouvelle version' : '') + '</small></span><span class="val">›</span></button></div>';
    return h;
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

  // ---------- Onglet Pièces (cartes + panneau) ----------
  var roomFilter = store.get('maison.roomf') || 'all', roomSheet = null;
  function roomStats(r) {
    var lights = r.items.filter(function (it) { return it.type === 'light'; }), on = lights.filter(isOn).length;
    var sh = r.items.filter(function (it) { return it.type === 'shutter'; });
    var up = sh.filter(function (i) { return shutterPos(i.id) === 'up'; }).length, down = sh.filter(function (i) { return shutterPos(i.id) === 'down'; }).length;
    var doors = r.items.filter(function (it) { return it.type === 'door'; }), openD = doors.filter(function (d) { return doorOpen(d.id); }).length;
    var parts = [];
    if (lights.length) parts.push(on ? on + ' lumière' + (on > 1 ? 's' : '') : 'éteint');
    if (sh.length) parts.push(sh.length > 1 ? (up === sh.length ? 'volets ouverts' : down === sh.length ? 'volets fermés' : up + '/' + sh.length + ' volets ouverts') : (up ? 'volet ouvert' : down ? 'volet fermé' : 'volet entrouvert'));
    if (doors.length) parts.push(openD ? 'porte ouverte' : 'porte fermée');
    r.items.forEach(function (it) {
      if (it.type === 'tuya-switch') parts.push(it.name.toLowerCase() + (tuOn(it.key) ? ' allumé' : ' éteint'));
      if (it.type === 'switch' && isOn(it)) parts.push(it.name.toLowerCase() + ' allumé');
      if (it.type === 'iaqua-exo' && IQ && IQ.exo && IQ.exo.ph != null) parts.push('pH ' + fmt(IQ.exo.ph, 1));
      if (it.type === 'garage') parts.push('porte de garage');
    });
    // Carte « Volets » de toute la maison : état de tous les volets
    var acts = r.items.filter(function (it) { return it.type === 'action' && (it.icon === 'up' || it.icon === 'down'); });
    if (acts.length && !sh.length) {
      var all = []; CFG.groups.forEach(function (g) { g.rooms.forEach(function (rm) { rm.items.forEach(function (it) { if (it.type === 'shutter') all.push(it); }); }); });
      var au = all.filter(function (i) { return shutterPos(i.id) === 'up'; }).length;
      parts.unshift(au === 0 ? 'tous fermés' : au === all.length ? 'tous ouverts' : au + ' / ' + all.length + ' ouverts');
    }
    if (!parts.length && r.items.some(function (it) { return it.type === 'sensor'; })) parts.push(r.items.filter(function (it) { return it.type === 'sensor'; }).length + ' mesures');
    return { lights: lights, on: on, sh: sh, openD: openD, acts: acts, text: parts.join(' · ') };
  }
  function roomsGridHTML() {
    var groups = CFG.groups.filter(function (g) { return g.rooms.length; });
    var h = '<div class="seg3">' + [['all', 'Tout']].concat(groups.map(function (g, i) { return ['g' + i, g.name === 'Rez-de-chaussée' ? 'Rez-de-ch.' : g.name]; })).map(function (f) {
      return '<button class="' + (roomFilter === f[0] ? 'on' : '') + '" data-roomf="' + f[0] + '">' + esc(f[1]) + '</button>';
    }).join('') + '</div>';
    groups.forEach(function (g, gi) {
      if (roomFilter !== 'all' && roomFilter !== 'g' + gi) return;
      h += '<div class="lbl">' + esc(g.name) + '</div><div class="rgrid2">' + g.rooms.map(function (r) {
        var s = roomStats(r), t = r.temp ? num(r.temp) : null, cam = roomHasCam(r);
        var q = '';
        if (s.lights.length) q += '<button class="qb' + (s.on ? ' l' : '') + '" data-lightall="' + r.id + '" aria-label="Lumières">' + icon('bulb') + '</button>';
        if (s.sh.length) q += '<button class="qb v" data-shutall="' + r.id + ':100" aria-label="Ouvrir les volets">' + icon('up') + '</button><button class="qb v" data-shutall="' + r.id + ':0" aria-label="Fermer les volets">' + icon('down') + '</button>';
        else s.acts.forEach(function (it) { q += '<button class="qb v" data-action="' + it.id + '" data-v="' + esc(it.value) + '" data-msg="' + esc(it.name) + '" aria-label="' + esc(it.name) + '">' + icon(it.icon) + '</button>'; });
        return '<div class="rc' + (s.on ? ' lit' : '') + (s.openD ? ' warn' : '') + '" data-roomopen="' + r.id + '" role="button" tabindex="0">' +
          '<div class="rc-hd"><b>' + esc(r.name) + '</b><span>' + (t == null ? '' : fmt(t, 1) + '°') + (cam ? icon('cam') : '') + '</span></div>' +
          '<small>' + esc(s.text || 'Détails') + '</small>' + (q ? '<div class="qa">' + q + '</div>' : '<div class="qa"><span class="qa-more">Ouvrir ›</span></div>') + '</div>';
      }).join('') + '</div>';
    });
    return h;
  }
  function openRoomSheet(id) {
    roomSheet = id; sheet.scrollTop = 0; openSheet('room');
    var r = findRoom(id); if (!r) return;
    if (r.items.some(function (it) { return /^tuya-/.test(it.type); })) refreshTuya(true);
    if (r.items.some(function (it) { return /^iaqua-/.test(it.type); })) refreshIq(true);
    if (r.camera) loadCams(false); if (roomHasCam(r)) loadImou(false);
  }
  function allShutters() {
    var list = []; CFG.groups.forEach(function (g) { g.rooms.forEach(function (rm) { var sh = rm.items.filter(function (it) { return it.type === 'shutter'; }); if (sh.length) list.push({ room: rm, sh: sh }); }); });
    return list;
  }
  function renderShuttersSheet(r) {
    var groups = allShutters(), all = []; groups.forEach(function (g) { all = all.concat(g.sh); });
    var up = all.filter(function (i) { return shutterPos(i.id) === 'up'; }).length, down = all.filter(function (i) { return shutterPos(i.id) === 'down'; }).length;
    var h = '<div class="sh-hd"><h2>Volets</h2><button class="close" data-close aria-label="Fermer">×</button></div>';
    h += '<div class="rs-sub">' + (up === 0 ? 'Tous fermés' : up === all.length ? 'Tous ouverts' : up + ' ouverts sur ' + all.length) + '</div>';
    h += '<div class="shblock"><div class="shb-hd"><span><b>Toute la maison</b><small>' + all.length + ' volets</small></span>' +
      '<span class="tri"><button data-shutall="*:100" class="' + (up === all.length ? 'on' : '') + '" aria-label="Tout ouvrir">' + icon('up') + '</button><button data-shutall="*:240" aria-label="Tout arrêter">' + icon('stop') + '</button><button data-shutall="*:0" class="' + (down === all.length ? 'on' : '') + '" aria-label="Tout fermer">' + icon('down') + '</button></span></div></div>';
    groups.forEach(function (g) {
      var gu = g.sh.filter(function (i) { return shutterPos(i.id) === 'up'; }).length;
      h += '<div class="shblock"><div class="shb-hd"><span><b>' + esc(g.room.name) + '</b><small>' + (g.sh.length > 1 ? (gu === 0 ? 'fermés' : gu === g.sh.length ? 'ouverts' : gu + ' / ' + g.sh.length + ' ouverts') : (gu ? 'ouvert' : 'fermé')) + '</small></span>' +
        (g.sh.length > 1 ? '<span class="tri"><button data-shutall="' + g.room.id + ':100" aria-label="Ouvrir">' + icon('up') + '</button><button data-shutall="' + g.room.id + ':240" aria-label="Stop">' + icon('stop') + '</button><button data-shutall="' + g.room.id + ':0" aria-label="Fermer">' + icon('down') + '</button></span>' : '') + '</div>' +
        '<div class="shlist">' + g.sh.map(rowHTML).join('') + '</div></div>';
    });
    var settings = r.items.filter(function (it) { return it.type === 'yesno'; });
    if (settings.length) h += '<div class="lbl" style="margin-left:4px">Réglages</div><div class="card2 flat rs-list">' + settings.map(rowHTML).join('') + '</div>';
    var keep = sheet.scrollTop; sheet.innerHTML = '<div class="sh-in">' + h + '</div>'; sheet.scrollTop = keep;
  }
  function renderRoomSheet() {
    var r = findRoom(roomSheet); if (!r) return;
    if (r.id === 'volets') return renderShuttersSheet(r);
    var s = roomStats(r), t = r.temp ? num(r.temp) : null, h = '';
    h += '<div class="sh-hd"><h2>' + esc(r.name) + '</h2><button class="close" data-close aria-label="Fermer">×</button></div>';
    h += '<div class="rs-sub">' + esc([t == null ? null : fmt(t, 1) + '°', s.text].filter(Boolean).join(' · ')) + '</div>';
    if (roomHasCam(r)) h += camPreviewHTML(r);
    if (s.lights.length) {
      h += '<div class="ltiles">' + s.lights.map(function (it) {
        var on = isOn(it);
        return '<button class="lt2' + (on ? ' on' : '') + (pending[it.id] ? ' busy' : '') + '" data-light="' + it.id + '"><span class="lt2-hd">' + icon('bulb') + '<span class="sw"></span></span><b>' + esc(it.name) + '</b><small>' + (on ? 'Allumée' : 'Éteinte') + '</small></button>';
      }).join('') + '</div>';
    }
    if (s.sh.length) {
      var up = s.sh.filter(function (i) { return shutterPos(i.id) === 'up'; }).length, down = s.sh.filter(function (i) { return shutterPos(i.id) === 'down'; }).length;
      h += '<div class="shblock"><div class="shb-hd"><span><b>' + (s.sh.length > 1 ? s.sh.length + ' volets' : 'Volet') + '</b><small>' + (up === s.sh.length ? 'Ouverts' : down === s.sh.length ? 'Fermés' : up + ' ouvert' + (up > 1 ? 's' : '') + ' sur ' + s.sh.length) + '</small></span>' +
        '<span class="tri"><button data-shutall="' + r.id + ':100" class="' + (up === s.sh.length ? 'on' : '') + '" aria-label="Tout ouvrir">' + icon('up') + '</button><button data-shutall="' + r.id + ':240" aria-label="Stop">' + icon('stop') + '</button><button data-shutall="' + r.id + ':0" class="' + (down === s.sh.length ? 'on' : '') + '" aria-label="Tout fermer">' + icon('down') + '</button></span></div>' +
        (s.sh.length > 1 ? '<div class="shlist">' + s.sh.map(rowHTML).join('') + '</div>' : '') + '</div>';
    }
    var others = r.items.filter(function (it) { return it.type !== 'light' && it.type !== 'shutter'; });
    var pools = others.filter(function (it) { return /^iaqua-/.test(it.type); }), rest = others.filter(function (it) { return !/^iaqua-/.test(it.type); });
    h += pools.map(rowHTML).join('');
    if (rest.length) h += '<div class="card2 flat rs-list">' + rest.map(rowHTML).join('') + '</div>';
    var keep = sheet.scrollTop; sheet.innerHTML = '<div class="sh-in">' + h + '</div>'; sheet.scrollTop = keep;
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

  var TITLES = { home: 'Accueil', rooms: 'Pièces', climate: 'Climat', cams: 'Caméras', alarm: 'Alarme', more: 'Plus' };
  function render() {
    if (!CFG || !token) return;
    var y = window.scrollY, body;
    if (TAB === 'rooms') body = roomsGridHTML();
    else if (TAB === 'climate') body = climateHTML();
    else if (TAB === 'cams') body = camsTabHTML();
    else if (TAB === 'more') body = moreHTML();
    else if (TAB === 'alarm') body = alarmHTML();
    else body = homeHTML();
    var d = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    app.innerHTML =
      '<header class="hd2"><div><small>' + (TAB === 'home' ? esc(d.charAt(0).toUpperCase() + d.slice(1)) + (userName ? ' · ' + esc(userName) : '') : '&nbsp;') + '</small><h1>' + TITLES[TAB] + '</h1></div>' +
      '<div class="hd-r"><div class="sync' + (offline ? ' off' : '') + '"><i></i>' + (offline ? 'Hors ligne' : lastOk ? ago(lastOk) : '…') + '</div>' +
      (TAB === 'home' ? '<button class="gear' + (newVersion ? ' dot' : '') + '" data-settings aria-label="Réglages">' + icon('gear') + '</button>' : '') + '</div></header>' +
      body + '<div class="foot">Maison v' + esc(LOG ? LOG.version : '…') + (lastOk ? ' · mis à jour ' + ago(lastOk) : '') + '</div>';
    window.scrollTo(0, y);
    tabsEl.hidden = false;
    Array.prototype.forEach.call(tabsEl.querySelectorAll('[data-tab]'), function (b) { b.classList.toggle('on', b.dataset.tab === TAB); });
    var mb = tabsEl.querySelector('[data-tab="more"]'); if (mb) mb.classList.toggle('dot', newVersion);
    if (!sheet.hidden && sheet.dataset.view === 'room' && !document.querySelector('#sheet .slide.dragging')) renderRoomSheet();
    if (!sheet.hidden && sheet.dataset.view === 'logs') renderLogs();
    var v = TAB === 'cams' && liveCam && document.getElementById('v-' + liveCam);
    if (v) v.addEventListener('error', function () { toast('La vidéo en direct s\'ouvre dans Safari sur iPhone', true); });
  }

  function setup() {
    tabsEl.hidden = true;
    app.innerHTML = '<div class="setup"><h1>Maison</h1><p>Cette appli n\'est pas encore reliée à ta maison. Ouvre le lien d\'installation (QR code) depuis cet iPhone.</p></div>';
  }

  // ---------- Panneaux plein écran : caméras et réglages ----------
  function openSheet(view) {
    sheet.dataset.view = view; sheet.hidden = false; document.body.classList.add('noscroll');
    if (view === 'cams') { loadCams(true); loadImou(false); renderCams(); }
    else if (view === 'rec') renderRec();
    else if (view === 'energy') renderEnergy();
    else if (view === 'cost') renderCost();
    else if (view === 'costappl') renderCostAppl();
    else if (view === 'timers') renderTimers();
    else if (view === 'plans') renderPlans();
    else if (view === 'logs') renderLogs();
    else if (view === 'room') renderRoomSheet();
    else if (view === 'graph') renderGraph();
    else if (view === 'plan') renderPlan();
    else renderSettings();
  }
  function closeSheet() {
    sheet.hidden = true; sheet.innerHTML = ''; liveCam = null; liveHd = true; REC = null; ENG = null; TED = null; PE = null; GR = null; roomSheet = null; logsView = null; document.body.classList.remove('noscroll');
  }

  // ---------- Plannings Netatmo : liste, création, modification (comme l'appli Netatmo) ----------
  var PLANS = null, PE = null, plansBusy = false;
  var DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  var ZTYPE = { 0: 'Confort', 1: 'Nuit', 5: 'Éco', 8: 'Confort+', 4: 'Personnalisée' };
  var ZCOL = { 0: '#FF8A5B', 1: '#7C83FF', 5: '#4ADE80', 8: '#F4B860' };
  var ZPAL = ['#38BDF8', '#F472B6', '#A3E635', '#FBBF24', '#C084FC', '#2DD4BF', '#FB7185', '#60A5FA'];
  function zName(z) { return z.name || ZTYPE[z.type] || 'Ambiance'; }
  function zColor(z) { return ZCOL[z.type] || ZPAL[z.id % ZPAL.length]; }
  function hmOf(o) { var m = o % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  function roomName(id) { var r = (PLANS && PLANS.rooms || []).filter(function (x) { return String(x.id) === String(id); })[0]; return r ? r.name : 'Pièce'; }
  function loadPlans(fresh) {
    plansBusy = true;
    return api({ action: 'nt.schedules', fresh: !!fresh }).then(function (j) { PLANS = j; plansBusy = false; })
      .catch(function () { plansBusy = false; toast('Netatmo ne répond pas, réessaie', true); });
  }
  function openPlans() { PE = null; sheet.scrollTop = 0; openSheet('plans'); loadPlans(true).then(function () { if (sheet.dataset.view === 'plans') renderPlans(); }); }
  function renderPlans() {
    var h = '<div class="sh-hd"><h2>Plannings</h2><button class="close" data-close aria-label="Fermer">×</button></div>';
    if (!PLANS) { sheet.innerHTML = '<div class="sh-in">' + h + '<p class="muted">Lecture des plannings Netatmo…</p></div>'; return; }
    h += '<div class="plist">' + PLANS.schedules.map(function (s) {
      var zs = s.zones.map(function (z) { return '<i style="background:' + zColor(z) + '"></i>'; }).join('');
      return '<div class="pcard' + (s.selected ? ' on' : '') + '"><div class="pc-hd"><b>' + esc(s.name) + '</b>' + (s.selected ? '<span class="pill2 ok">Actif</span>' : '') + '</div>' +
        '<small>' + s.zones.length + ' ambiances · ' + s.timetable.length + ' plages</small><div class="zdots">' + zs + '</div>' +
        '<div class="pc-btns">' + (s.selected ? '' : '<button class="act" data-pactivate="' + esc(s.id) + '">Activer</button>') +
        '<button class="act" data-pdup="' + esc(s.id) + '">Dupliquer</button><button class="act primary" data-pedit="' + esc(s.id) + '">Modifier</button></div></div>';
    }).join('') + '</div>';
    h += '<button class="act wide" data-pnew>' + icon('cal') + 'Nouveau planning</button>';
    h += '<p class="note-q">Un nouveau planning part d\'une copie du planning actif, que tu modifies ensuite. Pour supprimer un planning, utilise l\'appli Netatmo.</p>';
    sheet.innerHTML = '<div class="sh-in">' + h + '</div>';
  }
  function clonePlan(s) { return JSON.parse(JSON.stringify({ id: s.id, name: s.name, hg: s.hg, away: s.away, zones: s.zones, timetable: s.timetable })); }
  function createPlan(from, name) {
    var c = clonePlan(from); delete c.id; c.name = name.slice(0, 30);
    toast('Création du planning…');
    api({ action: 'nt.createschedule', schedule: c }).then(function () {
      toast('Planning « ' + c.name + ' » créé'); return loadPlans(true);
    }).then(function () { if (sheet.dataset.view === 'plans') renderPlans(); })
      .catch(function (e) { toast(e.message === 'invalid' ? 'Planning refusé' : 'Netatmo ne répond pas, réessaie', true); });
  }
  // ---- Éditeur ----
  function openPlan(id) {
    var s = PLANS.schedules.filter(function (x) { return String(x.id) === String(id); })[0]; if (!s) return;
    PE = { src: s.id, data: clonePlan(s), tab: 'week', day: (new Date().getDay() + 6) % 7, dirty: false, copy: null, zopen: null };
    sheet.scrollTop = 0; openSheet('plan');
  }
  function peTT() { return PE.data.timetable; }
  function peSort() {
    peTT().sort(function (a, b) { return a.o - b.o; });
    // Netatmo exige une plage le lundi à 00:00 : on la recrée avec l'ambiance en vigueur en fin de semaine
    if (!peTT().length || peTT()[0].o !== 0) { var last = peTT()[peTT().length - 1]; peTT().unshift({ o: 0, z: last ? last.z : PE.data.zones[0].id }); }
  }
  function zoneById(id) { return PE.data.zones.filter(function (z) { return z.id === id; })[0]; }
  function zoneAt(o) { var cur = peTT()[peTT().length - 1]; peTT().forEach(function (t) { if (t.o <= o) cur = t; }); return cur ? cur.z : null; }
  function dayBar(d) {
    var start = d * 1440, end = start + 1440, pts = [{ o: start, z: zoneAt(start) }];
    peTT().forEach(function (t) { if (t.o > start && t.o < end) pts.push(t); });
    var h = '<div class="dbar">';
    pts.forEach(function (p, i) {
      var to = i + 1 < pts.length ? pts[i + 1].o : end, z = zoneById(p.z) || {};
      h += '<span style="flex:' + (to - p.o) + ';background:' + zColor(z) + '" title="' + esc(zName(z)) + '"></span>';
    });
    return h + '</div><div class="dbar-l"><span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>24h</span></div>';
  }
  function zoneOptions(sel) {
    return PE.data.zones.map(function (z) { return '<option value="' + z.id + '"' + (z.id === sel ? ' selected' : '') + '>' + esc(zName(z)) + '</option>'; }).join('');
  }
  function renderPlan() {
    if (!PE) return;
    var D = PE.data, h = '';
    h += '<div class="sh-hd"><button class="back2" data-pback' + (PE.dirty ? ' data-confirm' : '') + '>' + icon('down') + '<span>Plannings</span></button>' +
      '<button class="act primary' + (PE.dirty ? '' : ' dim') + '" data-psave>Enregistrer</button></div>';
    h += '<input class="pname" id="pe-name" maxlength="30" value="' + esc(D.name) + '" aria-label="Nom du planning">';
    h += '<div class="en-tabs"><button class="' + (PE.tab === 'week' ? 'on' : '') + '" data-ptab="week">Semaine</button><button class="' + (PE.tab === 'zones' ? 'on' : '') + '" data-ptab="zones">Ambiances</button></div>';
    if (PE.tab === 'week') {
      h += '<div class="days">' + DAYS.map(function (n, i) { return '<button class="' + (i === PE.day ? 'on' : '') + '" data-pday="' + i + '">' + n.slice(0, 3) + '</button>'; }).join('') + '</div>';
      h += '<div class="en-card">' + dayBar(PE.day);
      var start = PE.day * 1440, end = start + 1440, rows = '';
      var first = peTT().filter(function (t) { return t.o === start; })[0];
      if (!first) {
        var zc = zoneById(zoneAt(start)) || {};
        rows += '<div class="slot inh"><span class="sw-c" style="background:' + zColor(zc) + '"></span><span class="slot-t">00:00</span><span class="slot-z">' + esc(zName(zc)) + ' <small>(suite de la veille)</small></span><span></span></div>';
      }
      peTT().forEach(function (t, i) {
        if (t.o < start || t.o >= end) return;
        var z = zoneById(t.z) || {}, locked = t.o === 0;
        rows += '<div class="slot"><span class="sw-c" style="background:' + zColor(z) + '"></span>' +
          (locked ? '<span class="slot-t">00:00</span>' : '<input type="time" step="900" class="slot-time" data-pe-time="' + i + '" value="' + hmOf(t.o) + '" aria-label="Heure">') +
          '<select class="slot-sel" data-pe-zone="' + i + '" aria-label="Ambiance">' + zoneOptions(t.z) + '</select>' +
          (locked ? '<span></span>' : '<button class="slot-del" data-pe-del="' + i + '" aria-label="Supprimer la plage">×</button>') + '</div>';
      });
      h += '<div class="slots">' + rows + '</div>';
      h += '<div class="pc-btns"><button class="act" data-pe-add>+ Ajouter une plage</button><button class="act" data-pe-copy>Copier ce jour…</button></div>';
      if (PE.copy) {
        h += '<div class="copybox"><small>Copier le ' + DAYS[PE.day].toLowerCase() + ' vers :</small><div class="days">' + DAYS.map(function (n, i) {
          return i === PE.day ? '' : '<button class="' + (PE.copy.indexOf(i) >= 0 ? 'on' : '') + '" data-pe-cpday="' + i + '">' + n.slice(0, 3) + '</button>';
        }).join('') + '</div><div class="pc-btns"><button class="act" data-pe-cpall>Tous les jours</button><button class="act primary" data-pe-cpgo>Copier</button></div></div>';
      }
      h += '</div><p class="note-q">Chaque plage démarre à l\'heure indiquée et dure jusqu\'à la suivante. Le lundi commence toujours à 00:00.</p>';
    } else {
      h += D.zones.map(function (z) {
        var open = PE.zopen === z.id, used = peTT().some(function (t) { return t.z === z.id; });
        var temps = z.rooms.map(function (r) { return r.t; }), mn = Math.min.apply(null, temps), mx = Math.max.apply(null, temps);
        var s = '<div class="zcard"><button class="zhd" data-pe-zopen="' + z.id + '"><span class="sw-c" style="background:' + zColor(z) + '"></span><span><b>' + esc(zName(z)) + '</b><small>' +
          (temps.length ? (mn === mx ? fmt(mn, 1) + '°' : fmt(mn, 1) + '° à ' + fmt(mx, 1) + '°') : '—') + (used ? '' : ' · non utilisée') + '</small></span>' + icon('down') + '</button>';
        if (open) {
          if (z.type === 4) s += '<div class="zname"><label for="pe-zn">Nom</label><input id="pe-zn" maxlength="30" data-pe-zname="' + z.id + '" value="' + esc(z.name || '') + '"></div>';
          s += '<div class="zrooms">' + z.rooms.map(function (r, ri) {
            return '<div class="zr"><span>' + esc(roomName(r.id)) + '</span><div class="stp"><button data-pe-t="' + z.id + ':' + ri + ':-0.5" aria-label="Moins">−</button><b>' + fmt(r.t, 1) + '°</b><button data-pe-t="' + z.id + ':' + ri + ':0.5" aria-label="Plus">+</button></div></div>';
          }).join('') + '</div>';
          s += '<div class="pc-btns"><button class="act" data-pe-zall="' + z.id + ':-0.5">Toutes −0,5°</button><button class="act" data-pe-zall="' + z.id + ':0.5">Toutes +0,5°</button>' +
            (z.type === 4 && !used ? '<button class="act danger" data-pe-zdel="' + z.id + '" data-confirm><span>Supprimer</span></button>' : '') + '</div>';
        }
        return s + '</div>';
      }).join('');
      h += '<button class="act wide" data-pe-zadd>+ Nouvelle ambiance</button>';
      h += '<div class="zcard"><div class="zrooms">' +
        '<div class="zr"><span>Hors-gel</span><div class="stp"><button data-pe-hg="-0.5">−</button><b>' + fmt(D.hg, 1) + '°</b><button data-pe-hg="0.5">+</button></div></div>' +
        '<div class="zr"><span>Absent</span><div class="stp"><button data-pe-away="-0.5">−</button><b>' + fmt(D.away, 1) + '°</b><button data-pe-away="0.5">+</button></div></div></div></div>';
      h += '<p class="note-q">Une ambiance, c\'est une température pour chaque pièce. Les ambiances Confort, Nuit et Éco ne peuvent pas être supprimées.</p>';
    }
    var keep = sheet.scrollTop;
    sheet.innerHTML = '<div class="sh-in">' + h + '</div>';
    sheet.scrollTop = keep;
  }
  function peChanged() { PE.dirty = true; renderPlan(); }
  function savePlan() {
    var nameEl = document.getElementById('pe-name'); if (nameEl) PE.data.name = nameEl.value.trim() || PE.data.name;
    peSort();
    var body = { action: 'nt.syncschedule', id: PE.src, schedule: { name: PE.data.name, hg: PE.data.hg, away: PE.data.away, zones: PE.data.zones, timetable: PE.data.timetable } };
    toast('Enregistrement chez Netatmo…');
    api(body).then(function () {
      PE.dirty = false; toast('Planning « ' + PE.data.name + ' » enregistré'); renderPlan();
      loadPlans(true); setTimeout(refreshHeating, 1500);
    }).catch(function (e) { toast(e.message === 'invalid' ? 'Planning refusé : vérifie les horaires' : 'Netatmo ne répond pas, réessaie', true); });
  }
  function clampT(t) { return Math.max(5, Math.min(30, Math.round(t * 2) / 2)); }

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
  var autoLive = store.get('maison.autolive') === '1', camHd = {}, camsSig = '';
  function camCardHTML(c) {
    var live = ((autoLive && TAB === 'cams') || liveCam === c.id) && c.live;
    var hd = camHd[c.id] !== undefined ? camHd[c.id] : (!autoLive && liveCam === c.id);
    var src = c.src === 'imou' && hd && c.liveHd ? c.liveHd : c.live;
    return '<div class="camcard" id="cc-' + esc(c.id) + '">' +
      (live ? '<video id="v-' + esc(c.id) + '" src="' + esc(src) + '" autoplay muted playsinline controls></video>'
        : '<button class="camimg" data-live="' + esc(c.id) + '"' + (c.live ? '' : ' disabled') + '>' + (c.snapshot ? '<img alt="" src="' + esc(snapUrl(c)) + '">' : '') +
          '<span class="play">' + icon('play') + (c.live ? 'Voir en direct' : 'Indisponible') + '</span></button>') +
      '<div class="cammeta"><b>' + esc(c.name) + '</b><span class="cm-r">' +
      (live && c.src === 'imou' && c.liveHd ? '<button class="hdbtn' + (hd ? ' on' : '') + '" data-hd="' + esc(c.id) + '">' + (hd ? 'HD' : 'SD') + '</button>' : '') +
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

  // ---------- Coût de l'énergie (estimation : gaz via Netatmo, électricité via Smart Life) ----------

  // Appareils non mesurés : consommations moyennes annuelles (kWh/an pour 1 appareil), réglables en nombre
  var APPL = [
    { id: 'frigous', name: 'Réfrigérateur américain', sub: 'en marche 24 h/24', kwh: 450, q: 1 },
    { id: 'frigo', name: 'Réfrigérateur', sub: 'en marche 24 h/24', kwh: 250, q: 1 },
    { id: 'cave', name: 'Cave à vin', sub: 'en marche 24 h/24', kwh: 200, q: 1 },
    { id: 'sserv', name: 'Sèche-serviettes 750 W', sub: '≈ 3 h par jour, les jours où le chauffage tourne', kwh: 470, q: 2, heat: true },
    { id: 'spots', name: 'Spots et éclairage LED', sub: '≈ 40 points lumineux, 5 h par jour (plus en hiver)', kwh: 365, q: 1, light: true },
    { id: 'slinge', name: 'Sèche-linge', sub: '≈ 4 séchages par semaine', kwh: 450, q: 1 },
    { id: 'llinge', name: 'Lave-linge', sub: '≈ 5 lavages par semaine', kwh: 200, q: 1 },
    { id: 'lvaiss', name: 'Lave-vaisselle', sub: '≈ 5 lavages par semaine', kwh: 230, q: 1 },
    { id: 'tv', name: 'TV OLED 60 pouces', sub: '≈ 3 h par jour + veille', kwh: 150, q: 3 },
    { id: 'plaques', name: 'Plaques de cuisson', sub: 'induction · mets 0 si tu cuisines au gaz', kwh: 350, q: 1 },
    { id: 'four', name: 'Four', sub: 'mets 0 s’il est au gaz', kwh: 120, q: 1 },
    { id: 'cafe', name: 'Machine à café', sub: 'avec la veille', kwh: 100, q: 1 },
    { id: 'micro', name: 'Micro-ondes', sub: '', kwh: 60, q: 1 },
    { id: 'hotte', name: 'Hotte', sub: 'moteur + éclairage', kwh: 40, q: 1 },
    { id: 'box', name: 'Box internet + décodeur TV', sub: 'en marche 24 h/24', kwh: 100, q: 1 },
    { id: 'vmc', name: 'VMC (ventilation)', sub: 'en marche 24 h/24 · mets 0 s’il n’y en a pas', kwh: 150, q: 1 },
    { id: 'divers', name: 'Ordinateurs, chargeurs, aspirateur, veilles…', sub: 'petits appareils', kwh: 300, q: 1 }
  ];
  var LIGHT_M = [1.35, 1.2, 1, 0.85, 0.7, 0.6, 0.6, 0.7, 0.85, 1.05, 1.25, 1.4]; // éclairage selon le mois
  function applQ(D, it) { var a = D.cfg.appl || {}; return a[it.id] != null ? a[it.id] : it.q; }
  // kWh estimés d'un appareil pour un jour (AAAAMMJJ) ; le jour même est compté au prorata de l'heure
  function applDay(D, it, dk) {
    var q = applQ(D, it); if (!q) return 0;
    var m = +dk.slice(4, 6) - 1, v;
    if (it.heat) {
      var gh = D.gas.days[dk], heating = gh != null ? gh > 0.5 : (m <= 3 || m >= 9);
      v = heating ? 0.75 * 3 : 0;
    } else v = it.kwh / 365 * (it.light ? LIGHT_M[m] : 1);
    if (dk === ymdK(new Date())) { var t = new Date(); v *= (t.getHours() + t.getMinutes() / 60) / 24; }
    return v * q;
  }
  function applYear(D, it) { return it.heat ? 0.75 * 3 * 210 : it.kwh; }
  var COST = null; // { tab, off, data, loading, error }
  var COST_ITEMS = [
    { k: 'gas', name: 'Chauffage (gaz)', icon: 'flame', color: '#FF8A5B' },
    { k: 'pac', name: 'Pompe à chaleur piscine', icon: 'thermo', color: '#FFC24B' },
    { k: 'elec', name: 'Électrolyseur + pompe', icon: 'bolt', color: '#5BA8FF' },
    { k: 'sauna', name: 'Sauna', icon: 'drop', color: '#B48CFF' },
    { k: 'other', name: 'Autres appareils (estimés)', icon: 'home', color: '#4CD38A' }
  ];
  function costLoad(body) {
    if (!COST) return;
    var b = body || { action: 'cost' };
    return api(b).then(function (j) {
      if (!COST) return; COST.data = j; COST.loading = false; COST.error = false;
      try { localStorage.setItem('maison-cost', JSON.stringify(j)); } catch (e) {}
      if (sheet.dataset.view === 'cost' && !sheet.hidden) renderCost();
      return j;
    }).catch(function (e) { if (COST) { COST.loading = false; COST.error = true; if (sheet.dataset.view === 'cost') renderCost(); } throw e; });
  }
  function openCost() {
    var cached = null; try { cached = JSON.parse(localStorage.getItem('maison-cost') || 'null'); } catch (e) {}
    COST = { tab: 'month', off: 0, data: cached, loading: true };
    sheet.scrollTop = 0; openSheet('cost'); costLoad().catch(function () {});
  }
  // Valeurs par jour (AAAAMMJJ) pour chaque poste, en kWh et en €
  function costDay(D, k) {
    var c = D.cfg, out = { kwh: 0, eur: 0, h: 0, any: false };
    if (k === 'gas') { var h = D.gas.days[COST_CUR]; if (h != null) { out.h = h; out.kwh = h * c.kw; out.eur = out.kwh * c.gasPrice; out.any = true; } }
    else if (k === 'other') { var o = 0; APPL.forEach(function (it) { o += applDay(D, it, COST_CUR); }); out.kwh = o; out.eur = o * c.elecPrice; out.any = true; }
    else { var e = D.elec[k] && D.elec[k].days[COST_CUR]; if (e != null) { out.kwh = e; out.eur = e * c.elecPrice; out.any = true; } }
    return out;
  }
  var COST_CUR = '';
  function costPeriod() {
    // Liste des jours de la période affichée + découpage pour le graphique
    var t = new Date(), tab = COST.tab, off = COST.off, days = [], groups = [], title = '';
    var dk = function (d) { return ymdK(d); };
    if (tab === 'day') {
      var d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + off); days = [dk(d)];
      title = off === 0 ? "Aujourd'hui" : off === -1 ? 'Hier' : d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    } else if (tab === 'week') {
      for (var i = 6; i >= 0; i--) { var w = new Date(t.getFullYear(), t.getMonth(), t.getDate() + off * 7 - i); days.push(dk(w)); groups.push({ label: 'LMMJVSD'.charAt((w.getDay() + 6) % 7), days: [dk(w)] }); }
      var a0 = new Date(+days[0].slice(0, 4), +days[0].slice(4, 6) - 1, +days[0].slice(6, 8));
      title = off === 0 ? '7 derniers jours' : 'Semaine du ' + a0.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    } else if (tab === 'month') {
      var m = new Date(t.getFullYear(), t.getMonth() + off, 1), nd = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      for (var j = 1; j <= nd; j++) { var md = new Date(m.getFullYear(), m.getMonth(), j); if (md > t) break; days.push(dk(md)); groups.push({ label: j === 1 || j % 10 === 0 ? String(j) : '', days: [dk(md)] }); }
      title = m.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    } else {
      var y = t.getFullYear() + off;
      for (var mo = 0; mo < 12; mo++) {
        var g = { label: 'JFMAMJJASOND'.charAt(mo), days: [] }, n2 = new Date(y, mo + 1, 0).getDate();
        for (var dd = 1; dd <= n2; dd++) { var yd = new Date(y, mo, dd); if (yd > t) break; g.days.push(dk(yd)); days.push(dk(yd)); }
        groups.push(g);
      }
      title = String(y);
    }
    return { days: days, groups: groups, title: title };
  }
  function costSum(D, list, k) {
    var s = { kwh: 0, eur: 0, h: 0, any: false };
    list.forEach(function (d) { COST_CUR = d; var v = costDay(D, k); if (v.any) { s.kwh += v.kwh; s.eur += v.eur; s.h += v.h; s.any = true; } });
    return s;
  }
  function eur(v, dec) { return v == null ? '—' : fmt(v, dec == null ? (v < 10 ? 2 : 0) : dec) + ' €'; }
  function renderCost() {
    if (!COST) return;
    var D = COST.data, h = '<div class="sh-hd"><h2>Énergie</h2><button class="close" data-close aria-label="Fermer">×</button></div>';
    h += '<div class="en-tabs c4">' + [['day', 'Jour'], ['week', 'Semaine'], ['month', 'Mois'], ['year', 'Année']].map(function (t) {
      return '<button class="' + (COST.tab === t[0] ? 'on' : '') + '" data-costtab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>';
    if (!D) { sheet.innerHTML = '<div class="sh-in">' + h + '<p class="muted">' + (COST.error ? 'La maison ne répond pas, réessaie dans un instant.' : 'Calcul en cours…') + '</p></div>'; return; }
    var P = costPeriod(), c = D.cfg;
    var tot = {}, total = 0, gasE = 0, elE = 0, gasK = 0, elK = 0;
    COST_ITEMS.forEach(function (it) { var s = costSum(D, P.days, it.k); tot[it.k] = s; total += s.eur; if (it.k === 'gas') { gasE += s.eur; gasK += s.kwh; } else { elE += s.eur; elK += s.kwh; } });
    var budget = c.budget * (COST.tab === 'day' ? 1 / 30 : COST.tab === 'week' ? 7 / 30 : COST.tab === 'month' ? 1 : 12);
    // Jauge : gaz puis électricité, par rapport au budget
    var R = 70, CC = 2 * Math.PI * R, fg = Math.min(1, gasE / budget), fe = Math.min(1 - fg, elE / budget);
    var ring = '<svg viewBox="0 0 170 170" width="170" height="170"><circle cx="85" cy="85" r="' + R + '" fill="none" stroke="var(--s3)" stroke-width="14"/>' +
      (fe > 0 ? '<circle cx="85" cy="85" r="' + R + '" fill="none" stroke="#5BA8FF" stroke-width="14" stroke-dasharray="' + (CC * (fg + fe)).toFixed(1) + ' ' + CC.toFixed(1) + '" transform="rotate(-90 85 85)" stroke-linecap="round"/>' : '') +
      (fg > 0 ? '<circle cx="85" cy="85" r="' + R + '" fill="none" stroke="#FF8A5B" stroke-width="14" stroke-dasharray="' + (CC * fg).toFixed(1) + ' ' + CC.toFixed(1) + '" transform="rotate(-90 85 85)" stroke-linecap="round"/>' : '') + '</svg>';
    var nDays = P.days.length || 1;
    h += '<div class="en-card cost-hero"><div class="en-period"><button data-coststep="-1" aria-label="Période précédente">' + icon('down') + '</button><span>' + esc(P.title.charAt(0).toUpperCase() + P.title.slice(1)) + '</span>' +
      '<button data-coststep="1" aria-label="Période suivante"' + (COST.off >= 0 ? ' disabled' : '') + '>' + icon('down') + '</button></div>' +
      '<span class="est">≈ estimation</span>' +
      '<div class="cring">' + ring + '<div class="crc"><b class="mono">' + eur(total, 0) + '</b><small>budget ' + eur(budget, 0) + '</small></div></div>' +
      '<div class="cost-k"><div><i style="background:#FF8A5B"></i><small>Gaz</small><b class="mono">' + eur(gasE, 0) + '</b><span>' + fmt(gasK, 0) + ' kWh</span></div>' +
      '<div><i style="background:#5BA8FF"></i><small>Électricité</small><b class="mono">' + eur(elE, 0) + '</b><span>' + fmt(elK, 0) + ' kWh</span></div>' +
      '<div><i style="background:var(--mu)"></i><small>Par jour</small><b class="mono">' + eur(total / nDays, total / nDays < 10 ? 2 : 0) + '</b><span>moyenne</span></div></div></div>';
    // Graphique empilé gaz / électricité
    if (P.groups.length) {
      var vals = P.groups.map(function (g) { var ga = costSum(D, g.days, 'gas').eur, el = 0; ['pac', 'elec', 'sauna', 'other'].forEach(function (k) { el += costSum(D, g.days, k).eur; }); return [ga, el]; });
      var W = 320, H = 140, base = 116, n = vals.length, gap = n > 20 ? 2 : 5, bw = (W - gap * (n - 1)) / n, max = Math.max.apply(null, vals.map(function (v) { return v[0] + v[1]; }).concat([0.01]));
      var s = '<svg class="bars" viewBox="0 0 ' + W + ' ' + H + '"><line x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '" class="axis"/>';
      vals.forEach(function (v, i) {
        var x = i * (bw + gap), hg = v[0] / max * (base - 10), he = v[1] / max * (base - 10);
        if (hg > 0) s += '<rect x="' + x.toFixed(1) + '" y="' + (base - hg).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hg.toFixed(1) + '" rx="2" fill="#FF8A5B"/>';
        if (he > 0) s += '<rect x="' + x.toFixed(1) + '" y="' + (base - hg - he).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(he, 1).toFixed(1) + '" rx="2" fill="#5BA8FF"/>';
        if (P.groups[i].label) s += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" class="lbl">' + P.groups[i].label + '</text>';
      });
      s += '<text x="' + W + '" y="10" text-anchor="end" class="lbl">' + eur(max, max < 10 ? 2 : 0) + '</text></svg>';
      h += '<div class="lbl">Coût ' + (COST.tab === 'year' ? 'par mois' : 'par jour') + '</div><div class="card2">' + s + '<div class="legend"><span><i style="background:#FF8A5B"></i>Gaz</span><span><i style="background:#5BA8FF"></i>Électricité</span></div></div>';
    }
    // Détail par appareil
    var mx = Math.max.apply(null, COST_ITEMS.map(function (it) { return tot[it.k].eur; }).concat([0.01]));
    h += '<div class="lbl">Détail</div><div class="card2 flat cost-list">' + COST_ITEMS.map(function (it) {
      var s = tot[it.k], sub = it.k === 'gas' ? fmt(s.h, 0) + ' h de chauffe · ' + fmt(s.kwh, 0) + ' kWh' : (s.any ? kwh(s.kwh) + ' kWh' : 'pas encore de relevé');
      if (it.k === 'other') sub = '≈ ' + kwh(s.kwh) + ' kWh · réfrigérateurs, lumières, TV, linge…';
      var tag = it.k === 'gas' ? 'div' : 'button';
      return '<' + tag + ' class="row"' + (it.k === 'gas' ? '' : it.k === 'other' ? ' data-costappl' : ' data-energy="' + it.k + '" data-ename="' + esc(it.name) + '"') + '><span class="ic" style="color:' + it.color + '">' + icon(it.icon) + '</span>' +
        '<span><b>' + esc(it.name) + '</b><small>' + esc(sub) + '</small><span class="cbar"><i style="width:' + (s.eur / mx * 100).toFixed(0) + '%;background:' + it.color + '"></i></span></span>' +
        '<span class="val mono">' + eur(s.eur) + '</span></' + tag + '>';
    }).join('') + '</div>';
    // Jours les plus chers
    if (COST.tab === 'month' || COST.tab === 'year') {
      var top = P.days.map(function (d) { var e = 0, gh = 0; COST_ITEMS.forEach(function (it) { var v = costSum(D, [d], it.k); e += v.eur; if (it.k === 'gas') gh = v.h; }); return { d: d, e: e, h: gh }; })
        .filter(function (x) { return x.e > 0; }).sort(function (a, b) { return b.e - a.e; }).slice(0, 4);
      if (top.length) h += '<div class="lbl">Les jours qui ont coûté le plus</div><div class="card2 flat cost-list">' + top.map(function (x) {
        var dt = new Date(+x.d.slice(0, 4), +x.d.slice(4, 6) - 1, +x.d.slice(6, 8));
        return '<div class="row"><span><b>' + esc(dt.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' })) + '</b><small>' + fmt(x.h, 1) + ' h de chauffe</small></span><span class="val mono">' + eur(x.e) + '</span></div>';
      }).join('') + '</div>';
    }
    // Réglages du calcul
    var st = function (f, label, sub, val, step) {
      return '<div class="row"><span><b>' + label + '</b><small>' + sub + '</small></span><span class="cset"><b class="mono">' + val + '</b><span class="stp2"><button data-costset="' + f + ':' + (-step) + '" aria-label="Moins">−</button><button data-costset="' + f + ':' + step + '" aria-label="Plus">+</button></span></span></div>';
    };
    h += '<div class="lbl">Réglages du calcul</div><div class="card2 flat cost-list">' +
      st('gasPrice', 'Prix du gaz', 'sur ta facture, en €/kWh', fmt(c.gasPrice, 3), 0.005) +
      st('kw', 'Puissance de la chaudière', c.kwSrc === 'compteur' ? 'calculée avec ton compteur ✓' : 'moyenne quand elle chauffe', fmt(c.kw, 1) + ' kW', 0.5) +
      st('elecPrice', 'Prix de l’électricité', 'en €/kWh', fmt(c.elecPrice, 3), 0.005) +
      st('budget', 'Budget mensuel', 'pour la jauge', fmt(c.budget, 0) + ' €', 10) + '</div>';
    // Relevé du compteur gaz
    var ms = c.meters || [], cal = D.calib;
    h += '<div class="lbl">Rendre le calcul du gaz exact</div><div class="card2 cost-meter">' +
      '<p>Note le chiffre de ton compteur gaz (en m³) aujourd’hui, puis à nouveau dans 1 à 2 semaines. L’appli en déduit la vraie puissance de ta chaudière.</p>' +
      '<div class="cm-in"><input id="cost-idx" inputmode="decimal" placeholder="Index du compteur (m³)" autocomplete="off"><button class="act" data-costmeter>Enregistrer</button></div>' +
      (ms.length ? '<ul>' + ms.map(function (m) { return '<li><span>' + new Date(m.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' à ' + new Date(m.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + '</span><b class="mono">' + fmt(m.idx, 2) + ' m³</b></li>'; }).join('') + '</ul>' : '') +
      (cal ? '<p class="ok2">' + (cal.kw ? 'Puissance calculée : ' + fmt(cal.kw, 1) + ' kW (' + fmt(cal.kwh, 0) + ' kWh pour ' + fmt(cal.hours, 0) + ' h de chauffe sur ' + fmt(cal.days, 0) + ' jours).' : 'Encore un peu de patience : il faut au moins 3 jours et 10 h de chauffe entre le premier et le dernier relevé.') + '</p>' : ms.length === 1 ? '<p class="ok2">1er relevé noté. Refais-le dans 1 à 2 semaines.</p>' : '') +
      (ms.length ? '<button class="cm-reset" data-costmeter-reset>Effacer les relevés</button>' : '') + '</div>';
    var since = ['pac', 'elec', 'sauna'].map(function (k) { return D.elec[k] && D.elec[k].since; }).filter(Boolean).sort()[0];
    h += '<p class="note-q">Estimation. Gaz = heures de chauffe de la chaudière (Netatmo) × puissance × prix ; seul le chauffage est compté (pas l’eau chaude ni la cuisson). Électricité = kWh mesurés par les prises Smart Life × prix, plus une estimation des autres appareils (consommations moyennes, réglables)' +
      (since ? ', relevés depuis le ' + (+since.slice(6, 8)) + '/' + since.slice(4, 6) : '') + '.' + (D.gas && D.gas.err ? ' Netatmo n’a pas répondu, chiffres du gaz peut-être incomplets.' : '') + '</p>';
    var keep = sheet.scrollTop; sheet.innerHTML = '<div class="sh-in">' + h + '</div>'; sheet.scrollTop = keep;
  }
  // Écran « Autres appareils » : liste réglable, consommation et coût par an
  function renderCostAppl() {
    var D = COST && COST.data; if (!D) return;
    var c = D.cfg, tot = 0, rows = APPL.map(function (it) {
      var q = applQ(D, it), y = applYear(D, it) * q; tot += y;
      return '<div class="row"><span><b>' + esc(it.name) + '</b>' + (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '<small class="ay">' + (q ? fmt(y, 0) + ' kWh/an · ≈ ' + eur(y * c.elecPrice, 0) + ' par an' : 'non compté') + '</small></span>' +
        '<span class="cset"><b class="mono">× ' + q + '</b><span class="stp2"><button data-applq="' + it.id + ':-1" aria-label="Moins">−</button><button data-applq="' + it.id + ':1" aria-label="Plus">+</button></span></span></div>';
    }).join('');
    var h = '<div class="sh-hd"><button class="back" data-costback>' + icon('down') + ' Énergie</button><button class="close" data-close aria-label="Fermer">×</button></div>' +
      '<h2 class="sh-t">Autres appareils</h2>' +
      '<div class="en-card cost-hero"><span class="est">≈ estimation</span><div class="appl-tot"><b class="mono">' + eur(tot * c.elecPrice / 12, 0) + '</b><small>par mois en moyenne · ' + fmt(tot, 0) + ' kWh/an · ≈ ' + eur(tot * c.elecPrice, 0) + '/an</small></div></div>' +
      '<div class="lbl">Ajuste le nombre de chaque appareil</div><div class="card2 flat cost-list appl">' + rows + '</div>' +
      '<p class="note-q">Consommations moyennes d’appareils récents pour une famille de 4. Les sèche-serviettes ne comptent que les jours où le chauffage a tourné (Netatmo) ; l’éclairage compte plus en hiver. Un ballon d’eau chaude électrique ou une piscine sont à part (la piscine est déjà mesurée).</p>';
    var keep = sheet.scrollTop; sheet.innerHTML = '<div class="sh-in">' + h + '</div>'; sheet.scrollTop = keep;
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
  // ---------- Notifications iPhone ----------
  var PUSH = { on: false, delay: 2, loaded: false, busy: false };
  var PUSH_DELAYS = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60];
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function pushStandalone() { return navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches); }
  function pushSub() { return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }); }
  function pushLoad() {
    if (!pushSupported() || !CFG.push) return;
    PUSH.loaded = true;
    pushSub().then(function (s) { return api({ action: 'push.get', endpoint: s ? s.endpoint : '' }); }).then(function (j) {
      PUSH.on = j.on; PUSH.delay = j.delay; if (sheet.dataset.view === 'settings' && !sheet.hidden) renderSettings();
    }).catch(function () { PUSH.loaded = false; });
  }
  function b64key(s) { var b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function pushToggle() {
    if (PUSH.busy) return; PUSH.busy = true; renderSettings();
    var end = function () { PUSH.busy = false; renderSettings(); };
    if (PUSH.on) {
      return pushSub().then(function (s) { return api({ action: 'push.unsub', endpoint: s ? s.endpoint : '' }).then(function () { return s && s.unsubscribe(); }); })
        .then(function () { PUSH.on = false; toast('Alertes désactivées sur cet iPhone'); }).catch(function () { toast('Impossible pour le moment, réessaie', true); }).then(end);
    }
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error('refus');
      return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64key(CFG.push.key) }); });
    }).then(function (s) { return api({ action: 'push.sub', endpoint: s.endpoint, name: userName }); })
      .then(function (j) { PUSH.on = j.on; PUSH.delay = j.delay; toast('Alertes activées sur cet iPhone'); })
      .catch(function (err) { toast(err && err.message === 'refus' ? 'Notifications refusées : autorise-les dans Réglages iPhone › Notifications › Maison' : 'Activation impossible, réessaie', true); })
      .then(end);
  }
  function pushHTML() {
    if (!CFG.push) return '';
    if (!PUSH.loaded) pushLoad();
    var h = '<h3>Notifications</h3>';
    if (!pushSupported() || !pushStandalone()) return h + '<p class="note-q">Pour recevoir les alertes, ouvre l’appli depuis son icône sur l’écran d’accueil (iPhone avec iOS 16.4 ou plus récent).</p>';
    var d = PUSH.delay, i = PUSH_DELAYS.indexOf(d);
    h += '<div class="card2 flat rs-list">' +
      '<button class="row' + (PUSH.on ? ' is-on' : '') + (PUSH.busy ? ' busy' : '') + '" data-push-toggle><span class="ic">' + icon('bell') + '</span><span><b>Alertes sur cet iPhone</b><small>' + (PUSH.on ? 'Notification et pastille sur l’icône' : 'Désactivées') + '</small></span><span class="sw"></span></button>' +
      '<div class="row"><span class="ic">' + icon('garage') + '</span><span><b>Porte de garage ouverte</b><small>Alerte après ' + d + ' min, rappel toutes les 30 min</small></span>' +
      '<span class="stp2"><button data-push-delay="' + (PUSH_DELAYS[i - 1] || d) + '" aria-label="Moins">−</button><button data-push-delay="' + (PUSH_DELAYS[i + 1] || d) + '" aria-label="Plus">+</button></span></div>' +
      (PUSH.on ? '<button class="row" data-push-test><span class="ic">' + icon('play') + '</span><span><b>Envoyer une notification de test</b><small>Pour vérifier que tout marche</small></span><span class="val">›</span></button>' : '') +
      '</div><p class="note-q">Le délai est le même pour toute la famille. Chacun active les alertes sur son propre iPhone.</p>';
    return h;
  }
  function renderSettings() {
    var L = LOG || { version: '—', releases: [], works: [], todo: [] };
    var h = '<div class="sh-hd"><h2>Réglages</h2><button class="close" data-close aria-label="Fermer">×</button></div>' +
      '<div class="card ver"><div><b>Maison</b><small>Version ' + esc(L.version) + (L.date ? ' · ' + esc(dateFr(L.date)) + (L.time ? ' à ' + esc(L.time) : '') : '') + '</small></div>' +
      '<button class="act" data-update>Vérifier</button></div>' +
      '<div class="card"><div class="kv"><span>Connecté en tant que</span><b>' + esc(userName || '—') + '</b></div>' +
      '<div class="kv"><span>Box eedomus</span><b class="' + (offline ? 'bad' : 'ok') + '">' + (offline ? 'Hors ligne' : lastOk ? 'Connectée' : '…') + '</b></div>' +
      '<div class="kv"><span>Netatmo</span><b class="' + (NT ? 'ok' : ntErr ? 'bad' : '') + '">' + (NT ? 'Connecté' : ntErr ? 'Indisponible' : '…') + '</b></div></div>' +
      pushHTML() +
      '<h3>Suivi du projet</h3>' +
      '<details class="acc2"><summary><span>Ce qui fonctionne</span><span class="cnt ok">' + L.works.length + '</span>' + icon('down') + '</summary>' +
      '<ul class="lst ok">' + L.works.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></details>' +
      '<details class="acc2"><summary><span>Reste à faire</span><span class="cnt todo">' + L.todo.length + '</span>' + icon('down') + '</summary>' +
      '<ul class="lst todo">' + L.todo.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></details>' +
      '<h3>Dernières versions</h3>' + L.releases.slice(0, 3).map(function (r, i) {
        return '<details class="acc2 rel"><summary><span class="rel-v">v' + esc(r.version) + '</span>' +
          '<span class="rel-t"><b>' + esc(r.title) + '</b><small>' + esc(dateFr(r.date)) + (r.time ? ' à ' + esc(r.time) : '') + '</small></span>' +
          (i === 0 ? '<span class="new">Actuelle</span>' : '') + icon('down') + '</summary>' +
          '<ul>' + r.changes.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></details>';
      }).join('') + (L.releases.length > 3 ? '<p class="note-q">' + (L.releases.length - 3) + ' versions plus anciennes ne sont pas affichées.</p>' : '') +
      '<p class="note-q">Les mises à jour s\'installent toutes seules à l\'ouverture de l\'appli.</p>';
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
  function appClick(e) {
    var b;
    if ((b = e.target.closest('[data-settings]'))) return openSheet('settings');
    if (e.target.closest('[data-cost]')) return openCost();
    if ((b = e.target.closest('[data-opencams]'))) { if (!sheet.hidden) closeSheet(); liveCam = b.dataset.opencams; liveHd = true; TAB = 'cams'; store.set('maison.tab', TAB); loadCams(false); loadImou(false); render();
      var cc = document.getElementById('cc-' + liveCam); if (cc) cc.scrollIntoView({ block: 'center' }); return; }
    // Accès rapide de l'accueil
    if ((b = e.target.closest('[data-logs]'))) return openLogs(b.dataset.logs);
    if ((b = e.target.closest('[data-garmark]'))) {
      var gs = b.dataset.garmark;
      return api({ action: 'garage.mark', state: gs }).then(function (j) { GAR = j.garage; if (LOGS.doors) LOGS.doors.at = 0; render(); if (logsView) renderLogs(); toast('Porte de garage : ' + (gs === 'open' ? 'ouverte' : 'fermée')); })
        .catch(function () { toast('Impossible d\'enregistrer, réessaie', true); });
    }
    if ((b = e.target.closest('[data-yesno]'))) { var yid = +b.dataset.yesno; return send(yid, num(yid) === 1 ? 0 : 1); }
    if ((b = e.target.closest('[data-choice]'))) { var cp = b.dataset.choice.split(':'); return send(+cp[0], +cp[1]); }
    if ((b = e.target.closest('[data-graph]'))) return openGraph(b.dataset.graph);
    if ((b = e.target.closest('[data-nt-homeroom]'))) return resetRoom(b.dataset.ntHomeroom);
    if ((b = e.target.closest('[data-qa]'))) {
      var qa = b.dataset.qa;
      if (qa === 'gate') return openSlide('gate', 'home');
      if (qa === 'garage') return openSlide('garage', 'home');
      if (qa === 'alarm') return openSlide(alarmArmed() ? 'alarm-off' : 'alarm-on', 'home');
      if (qa === 'sauna') { if (tuOn('sauna')) { SLIDE = null; return saunaSet(false); } return openSlide('sauna-on', 'home'); }
    }
    if ((b = e.target.closest('[data-slideopen]'))) { var so = b.dataset.slideopen.split(':'); return openSlide(so[0], so[1]); }
    if ((b = e.target.closest('[data-slidekey]'))) { SLIDE.key = b.dataset.slidekey; return render(); }
    if (e.target.closest('[data-slidex]')) { SLIDE = null; return render(); }
    if ((b = e.target.closest('[data-goto]'))) { TAB = b.dataset.goto; store.set('maison.tab', TAB); window.scrollTo(0, 0); if (TAB === 'more') { refreshIq(true); refreshTuya(true); } return render(); }
    if ((b = e.target.closest('[data-roomf]'))) { roomFilter = b.dataset.roomf; store.set('maison.roomf', roomFilter); return render(); }
    if ((b = e.target.closest('[data-lightall]'))) {
      var lr = findRoom(b.dataset.lightall), ls = lr.items.filter(function (it) { return it.type === 'light'; }), anyOn = ls.some(isOn);
      ls.forEach(function (it) { if (isOn(it) === anyOn) send(it.id, anyOn ? (it.off !== undefined ? it.off : 0) : (it.on !== undefined ? it.on : 100)); });
      toast(lr.name + (anyOn ? ' : lumières éteintes' : ' : lumières allumées')); return;
    }
    if ((b = e.target.closest('[data-shutall]'))) {
      var sp = b.dataset.shutall.split(':'), sv = +sp[1], list, label;
      if (sp[0] === '*') { list = []; allShutters().forEach(function (g) { list = list.concat(g.sh); }); label = 'Tous les volets'; }
      else { var sr = findRoom(sp[0]); list = sr.items.filter(function (it) { return it.type === 'shutter'; }); label = sr.name; }
      list.forEach(function (it) { send(it.id, sv); });
      toast(label + ' : ' + (sv === 100 ? 'ouverture' : sv === 0 ? 'fermeture' : 'arrêt')); return;
    }
    if ((b = e.target.closest('[data-roomopen]'))) return openRoomSheet(b.dataset.roomopen);
    if ((b = e.target.closest('[data-goroom]'))) {
      TAB = 'rooms'; store.set('maison.tab', TAB); render(); return openRoomSheet(b.dataset.goroom);
    }
    // Caméras (onglet)
    if ((b = e.target.closest('[data-live]'))) { liveCam = b.dataset.live; liveHd = true; return render(); }
    if ((b = e.target.closest('[data-hd]'))) { var hid = b.dataset.hd; camHd[hid] = !(camHd[hid] !== undefined ? camHd[hid] : (!autoLive && liveCam === hid)); return render(); }
    if (e.target.closest('[data-autolive]')) { autoLive = !autoLive; store.set('maison.autolive', autoLive ? '1' : '0'); liveCam = null; return render(); }
    if ((b = e.target.closest('[data-rec]'))) return openRec(b.dataset.rec);
    if ((b = e.target.closest('[data-evplay]'))) return playEvent(b.dataset.evplay);
    if ((b = e.target.closest('[data-ntroom]'))) { ntRoom = b.dataset.ntroom; store.set('maison.ntRoom', ntRoom); ntPend = null; loadRoomHist(ntRoom); return render(); }
    if ((b = e.target.closest('[data-nt-step]'))) return stepSetpoint(parseFloat(b.dataset.ntStep));
    if ((b = e.target.closest('[data-nt-home]'))) {
      var r = ntCurrentRoom();
      return api({ action: 'nt.setpoint', room: r.id, mode: 'home' }).then(function (j) { NT = j; render(); toast(r.name + ' : retour au planning'); })
        .catch(function () { toast('Netatmo ne répond pas, réessaie', true); });
    }
    if (e.target.closest('[data-plans]')) { schedOpen = false; render(); return openPlans(); }
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
      var names = { 'exo:boost': 'Boost', 'exo:pump': 'Filtration', 'exo:aux1': 'Éclairage piscine', 'hp:on': 'Pompe à chaleur' };
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
  }
  app.addEventListener('click', appClick);
  sheet.addEventListener('click', function (e) {
    var b;
    if (e.target.closest('[data-close]')) return closeSheet();
    if (sheet.dataset.view === 'room' || sheet.dataset.view === 'logs') return appClick(e); // panneaux : mêmes commandes que l'appli
    if ((b = e.target.closest('[data-live]'))) { liveCam = b.dataset.live; liveHd = true; return renderCams(); }
    if (e.target.closest('[data-hd]')) { liveHd = !liveHd; return renderCams(); }
    if ((b = e.target.closest('[data-rec]'))) return openRec(b.dataset.rec);
    if ((b = e.target.closest('[data-entab]'))) { ENG.tab = b.dataset.entab; return renderEnergy(); }
    if ((b = e.target.closest('[data-energy]')) && sheet.dataset.view === 'cost') return openEnergy(b.dataset.energy, b.dataset.ename);
    if (e.target.closest('[data-costappl]')) { sheet.scrollTop = 0; return openSheet('costappl'); }
    if (e.target.closest('[data-costback]')) { sheet.scrollTop = 0; return openSheet('cost'); }
    if ((b = e.target.closest('[data-applq]'))) {
      var aq = b.dataset.applq.split(':'), it2 = APPL.filter(function (x) { return x.id === aq[0]; })[0], cfa = COST.data.cfg;
      cfa.appl = cfa.appl || {}; var nq = Math.max(0, Math.min(60, applQ(COST.data, it2) + +aq[1])); if (nq === applQ(COST.data, it2)) return;
      cfa.appl[aq[0]] = nq; renderCostAppl(); var pa = {}; pa[aq[0]] = nq;
      return api({ action: 'cost.cfg', appl: pa }).then(function (j) { COST.data = j; try { localStorage.setItem('maison-cost', JSON.stringify(j)); } catch (e) {} if (sheet.dataset.view === 'costappl') renderCostAppl(); })
        .catch(function () { toast('Réglage non enregistré, réessaie', true); });
    }
    if ((b = e.target.closest('[data-costtab]'))) { COST.tab = b.dataset.costtab; COST.off = 0; return renderCost(); }
    if ((b = e.target.closest('[data-coststep]'))) { var nv2 = COST.off + +b.dataset.coststep; if (nv2 > 0) return; COST.off = nv2; return renderCost(); }
    if ((b = e.target.closest('[data-costset]'))) {
      var fs = b.dataset.costset.split(':'), cf = COST.data.cfg, nvv = Math.round((cf[fs[0]] + +fs[1]) * 1000) / 1000, q = { action: 'cost.cfg' };
      q[fs[0]] = nvv; cf[fs[0]] = nvv; if (fs[0] === 'kw') cf.kwSrc = 'manuel'; renderCost();
      return costLoad(q).catch(function () { toast('Réglage non enregistré, réessaie', true); costLoad().catch(function () {}); });
    }
    if (e.target.closest('[data-costmeter-reset]')) { if (!confirm('Effacer tous les relevés du compteur ?')) return; return costLoad({ action: 'cost.meter', reset: true }).catch(function () { toast('Impossible pour le moment', true); }); }
    if (e.target.closest('[data-costmeter]')) {
      var inp = document.getElementById('cost-idx'), v = inp && inp.value.trim();
      if (!v) return toast('Tape le chiffre du compteur', true);
      return costLoad({ action: 'cost.meter', index: v }).then(function () { toast('Relevé enregistré'); })
        .catch(function (err) { toast(/index_lower/.test(err.message) ? 'Ce chiffre est plus petit que le relevé précédent' : 'Chiffre non valable, vérifie-le', true); });
    }
    if ((b = e.target.closest('[data-grange]'))) { GR.range = b.dataset.grange; GR.end = null; return loadGraph(); }
    if ((b = e.target.closest('[data-groom]'))) { GR.room = b.dataset.groom; GR.end = null; return loadGraph(); }
    if ((b = e.target.closest('[data-gstep]'))) {
      var span = GR_RANGES.filter(function (r) { return r[0] === GR.range; })[0][2], now = Math.floor(Date.now() / 1000);
      var ne = (GR.end || now) + (+b.dataset.gstep) * span; GR.end = ne >= now ? null : ne; return loadGraph();
    }
    // --- Plannings Netatmo ---
    if ((b = e.target.closest('[data-pactivate]'))) {
      var pid = b.dataset.pactivate; b.classList.add('busy');
      return api({ action: 'nt.schedule', id: pid }).then(function (j) { NT = j; render(); toast('Planning activé'); return loadPlans(true); })
        .then(function () { if (sheet.dataset.view === 'plans') renderPlans(); }).catch(function () { b.classList.remove('busy'); toast('Netatmo ne répond pas, réessaie', true); });
    }
    if ((b = e.target.closest('[data-pdup]'))) {
      var ps = PLANS.schedules.filter(function (x) { return String(x.id) === b.dataset.pdup; })[0];
      return ps && createPlan(ps, ps.name.slice(0, 22) + ' (copie)');
    }
    if (e.target.closest('[data-pnew]')) {
      var act = PLANS.schedules.filter(function (x) { return x.selected; })[0] || PLANS.schedules[0];
      return act && createPlan(act, 'Nouveau planning');
    }
    if ((b = e.target.closest('[data-pedit]'))) return openPlan(b.dataset.pedit);
    if ((b = e.target.closest('[data-pback]'))) {
      if (PE && PE.dirty && !confirmed(b)) { var lb = b.querySelector('span'); if (lb) lb.textContent = 'Quitter sans enregistrer ?'; return; }
      PE = null; sheet.dataset.view = 'plans'; sheet.scrollTop = 0; return renderPlans();
    }
    if (e.target.closest('[data-psave]')) { if (PE && PE.dirty) savePlan(); return; }
    if ((b = e.target.closest('[data-ptab]'))) { PE.tab = b.dataset.ptab; PE.copy = null; return renderPlan(); }
    if ((b = e.target.closest('[data-pday]'))) { PE.day = +b.dataset.pday; PE.copy = null; return renderPlan(); }
    if ((b = e.target.closest('[data-pe-del]'))) { peTT().splice(+b.dataset.peDel, 1); peSort(); return peChanged(); }
    if (e.target.closest('[data-pe-add]')) {
      var base = PE.day * 1440, taken = peTT().map(function (t) { return t.o; }), mins = 12 * 60;
      while (taken.indexOf(base + mins) >= 0 && mins < 1410) mins += 30;
      if (taken.indexOf(base + mins) >= 0) return toast('Plus de place ce jour-là', true);
      var conf = PE.data.zones.filter(function (z) { return z.type === 0; })[0] || PE.data.zones[0];
      peTT().push({ o: base + mins, z: conf.id }); peSort(); return peChanged();
    }
    if (e.target.closest('[data-pe-copy]')) { PE.copy = PE.copy ? null : []; return renderPlan(); }
    if ((b = e.target.closest('[data-pe-cpday]'))) {
      var cd = +b.dataset.peCpday, ci = PE.copy.indexOf(cd);
      if (ci >= 0) PE.copy.splice(ci, 1); else PE.copy.push(cd); return renderPlan();
    }
    if (e.target.closest('[data-pe-cpall]')) { PE.copy = [0, 1, 2, 3, 4, 5, 6].filter(function (d) { return d !== PE.day; }); return renderPlan(); }
    if (e.target.closest('[data-pe-cpgo]')) {
      if (!PE.copy.length) return toast('Choisis au moins un jour', true);
      var s0 = PE.day * 1440, src = peTT().filter(function (t) { return t.o >= s0 && t.o < s0 + 1440; }).map(function (t) { return { r: t.o - s0, z: t.z }; });
      if (!src.some(function (t) { return t.r === 0; })) src.unshift({ r: 0, z: zoneAt(s0) });
      var targets = PE.copy.slice();
      PE.data.timetable = peTT().filter(function (t) { return targets.indexOf(Math.floor(t.o / 1440)) < 0; });
      targets.forEach(function (d) { src.forEach(function (t) { peTT().push({ o: d * 1440 + t.r, z: t.z }); }); });
      peSort(); PE.copy = null; toast('Copié vers ' + targets.length + ' jour' + (targets.length > 1 ? 's' : '')); return peChanged();
    }
    if ((b = e.target.closest('[data-pe-zopen]'))) { var zid = +b.dataset.peZopen; PE.zopen = PE.zopen === zid ? null : zid; return renderPlan(); }
    if ((b = e.target.closest('[data-pe-t]'))) {
      var pt = b.dataset.peT.split(':'), zz = zoneById(+pt[0]); if (!zz) return;
      zz.rooms[+pt[1]].t = clampT(zz.rooms[+pt[1]].t + parseFloat(pt[2])); return peChanged();
    }
    if ((b = e.target.closest('[data-pe-zall]'))) {
      var pa = b.dataset.peZall.split(':'), za = zoneById(+pa[0]); if (!za) return;
      za.rooms.forEach(function (r) { r.t = clampT(r.t + parseFloat(pa[1])); }); return peChanged();
    }
    if ((b = e.target.closest('[data-pe-zdel]'))) {
      if (!confirmed(b)) return;
      var zd = +b.dataset.peZdel; PE.data.zones = PE.data.zones.filter(function (z) { return z.id !== zd; }); PE.zopen = null; return peChanged();
    }
    if (e.target.closest('[data-pe-zadd]')) {
      if (PE.data.zones.length >= 12) return toast('12 ambiances au maximum', true);
      var nid = Math.max.apply(null, PE.data.zones.map(function (z) { return z.id; })) + 1;
      var ref = PE.data.zones.filter(function (z) { return z.type === 0; })[0] || PE.data.zones[0];
      PE.data.zones.push({ id: nid, name: 'Nouvelle ambiance', type: 4, rooms: JSON.parse(JSON.stringify(ref.rooms)) });
      PE.zopen = nid; return peChanged();
    }
    if ((b = e.target.closest('[data-pe-hg]'))) { PE.data.hg = Math.max(5, Math.min(15, Math.round((PE.data.hg + parseFloat(b.dataset.peHg)) * 2) / 2)); return peChanged(); }
    if ((b = e.target.closest('[data-pe-away]'))) { PE.data.away = Math.max(10, Math.min(25, Math.round((PE.data.away + parseFloat(b.dataset.peAway)) * 2) / 2)); return peChanged(); }
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
    if (e.target.closest('[data-recback]')) return closeSheet(); // retour à l'onglet Caméras
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
    if (e.target.closest('[data-push-toggle]')) return pushToggle();
    if ((b = e.target.closest('[data-push-delay]'))) {
      var nd = +b.dataset.pushDelay; if (nd === PUSH.delay) return;
      var od = PUSH.delay; PUSH.delay = nd; renderSettings();
      return api({ action: 'push.cfg', delay: nd }).then(function (j) { PUSH.delay = j.delay; renderSettings(); }).catch(function () { PUSH.delay = od; renderSettings(); toast('Réglage non enregistré, réessaie', true); });
    }
    if (e.target.closest('[data-push-test]')) {
      toast('Envoi de la notification…');
      return pushSub().then(function (s) { return fetch(CFG.api, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ token: token, action: 'push.test', endpoint: s ? s.endpoint : '' }) }); })
        .then(function (r) { return r.json(); }).then(function (j) { toast(j.ok ? 'Notification envoyée : regarde en haut de l’écran' : 'Échec de l’envoi (' + (j.error || '?') + ')', !j.ok); })
        .catch(function () { toast('Échec de l’envoi, réessaie', true); });
    }
    if (e.target.closest('[data-update]')) {
      toast('Recherche de mise à jour…');
      var done = function () { location.reload(); };
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then(function (reg) { return reg ? reg.update() : null; }).then(done, done);
      } else done();
    }
  });
  // Champs de saisie de l'éditeur de planning (heure, ambiance, noms)
  sheet.addEventListener('change', function (e) {
    if (!PE) return;
    var t = e.target;
    if (t.id === 'pe-name') { var nv = t.value.trim().slice(0, 30); if (nv && nv !== PE.data.name) { PE.data.name = nv; peChanged(); } return; }
    if (t.hasAttribute('data-pe-zname')) { var zn = zoneById(+t.dataset.peZname); if (zn && t.value.trim()) { zn.name = t.value.trim().slice(0, 30); peChanged(); } return; }
    if (t.hasAttribute('data-pe-zone')) { peTT()[+t.dataset.peZone].z = +t.value; return peChanged(); }
    if (t.hasAttribute('data-pe-time')) {
      var m = /^([0-9][0-9]):([0-9][0-9])$/.exec(t.value || ''); if (!m) return renderPlan();
      var o = PE.day * 1440 + (+m[1]) * 60 + (+m[2]), i = +t.dataset.peTime;
      if (o === 0 || peTT().some(function (x, j) { return j !== i && x.o === o; })) { toast('Une plage existe déjà à cette heure', true); return renderPlan(); }
      peTT()[i].o = o; peSort(); return peChanged();
    }
  });
  // ---------- Barre d'onglets ----------
  tabsEl.addEventListener('click', function (e) {
    var b = e.target.closest('[data-tab]'); if (!b || !CFG) return;
    var t = b.dataset.tab;
    if (t === TAB) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (TAB === 'cams') liveCam = null;
    TAB = t; store.set('maison.tab', TAB); SLIDE = null; window.scrollTo(0, 0);
    if (t === 'cams') { loadCams(false); loadImou(false); }
    if (t === 'more') { refreshIq(true); refreshTuya(true); loadEnergyToday(); loadHistE(3557564, 168); }
    if (t === 'climate') { var r = ntCurrentRoom(); if (r) loadRoomHist(r.id); }
    if (t === 'alarm') refresh();
    render();
  });

  // ---------- Glisser pour confirmer (portail, garage, alarme, allumage du sauna) ----------
  var drag = null;
  document.addEventListener('pointerdown', function (e) {
    var k = e.target.closest('.slide .knob'); if (!k) return;
    var sl = k.parentNode;
    drag = { sl: sl, k: k, x0: e.clientX - k.offsetLeft, max: sl.clientWidth - k.offsetWidth - 4 };
    sl.classList.add('dragging'); k.style.transition = 'none';
    try { k.setPointerCapture(e.pointerId); } catch (x) {}
    e.preventDefault();
  });
  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var x = Math.max(4, Math.min(drag.max, e.clientX - drag.x0));
    drag.k.style.left = x + 'px';
    drag.sl.style.setProperty('--p', ((x - 4) / Math.max(1, drag.max - 4)).toFixed(3));
  });
  function endDrag() {
    if (!drag) return;
    var d = drag; drag = null; d.k.style.transition = ''; d.sl.classList.remove('dragging');
    if (d.k.offsetLeft >= d.max - 8) { d.sl.classList.add('done'); doSlide(d.sl.dataset.slide); }
    else { d.k.style.left = '4px'; d.sl.style.setProperty('--p', 0); }
  }
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  function findItem(id) {
    var f = null;
    CFG.groups.forEach(function (g) { g.rooms.forEach(function (r) { r.items.forEach(function (it) { if (it.id === id) f = it; }); }); });
    return f;
  }

  // ---------- Mise à jour automatique ----------
  var updating = false;
  function checkUpdate() {
    if (updating || !LOG) return;
    fetch('changelog.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (l) {
      if (!l || !l.version || l.version === LOG.version) return;
      // pas de rechargement pendant une saisie (éditeur de planning, glissement, vidéo)
      if ((PE && PE.dirty) || document.querySelector('.slide.dragging') || TED) return;
      updating = true; toast('Mise à jour vers la version ' + l.version + '…');
      var go = function () { location.reload(); };
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then(function (reg) { return reg ? reg.update() : null; }).then(function () { setTimeout(go, 900); }, function () { setTimeout(go, 900); });
      } else setTimeout(go, 900);
    }).catch(function () {});
  }
  setInterval(function () { if (!document.hidden) checkUpdate(); }, 180000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { checkUpdate(); clearBadge(); } });
  // Pastille rouge sur l'icône : effacée à chaque ouverture de l'appli (l'alerte a été vue)
  function clearBadge() { try { if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch (e) {} }
  clearBadge();

  // ---------- Démarrage ----------
  fetch('changelog.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (l) {
    LOG = l;
    var seen = store.get('maison.seenVersion');
    if (!seen) store.set('maison.seenVersion', l.version);
    else if (seen !== l.version) { newVersion = true; setTimeout(function () { toast('Appli mise à jour : version ' + l.version); }, 1200); }
    render();
  }).catch(function () {});

  fetch('config.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (c) {
    CFG = c;
    if (!token) return setup();
    render(); refresh(); refreshHeating(); refreshTuya(true); refreshIq(false);
    if (TAB === 'cams') { loadCams(false); loadImou(false); }
    if (TAB === 'more') { loadEnergyToday(); loadHistE(3557564, 168); }
    setInterval(function () { if (!document.hidden) refreshIq(false); }, 60000);
    setInterval(function () { if (!document.hidden) refresh(); }, 10000);
    setInterval(function () { if (!document.hidden && GAR && GAR.state === 'unknown') loadLogs('doors', true); }, 15000);
    setInterval(function () { if (!document.hidden && !ntPend) refreshHeating(); }, 30000);
    setInterval(function () { if (!document.hidden) refreshTuya(); }, 30000);
    setInterval(function () { if (!document.hidden && lastOk && !busy()) render(); }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh(); refreshHeating(); refreshTuya(true); } });
  }).catch(function () { app.innerHTML = '<div class="setup"><h1>Maison</h1><p>Impossible de charger la configuration. Vérifie ta connexion.</p></div>'; });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
    // toucher la notification « garage » ouvre le journal des portes
    navigator.serviceWorker.addEventListener('message', function (ev) { if (ev.data && /logs=doors/.test(ev.data.open || '')) openLogs('doors'); });
  }
  if (/logs=doors/.test(location.hash)) setTimeout(function () { openLogs('doors'); }, 600);
})();
