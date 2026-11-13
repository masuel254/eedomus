// Crée ou met à jour le workflow n8n "Maison · API eedomus".
// Les secrets sont lus dans .env (jamais publié) et injectés uniquement dans n8n.
// Usage : node scripts/deploy-n8n.mjs
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

function loadEnv() {
  const env = {};
  for (const line of readFileSync(envPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
if (!env.MAISON_TOKEN) {
  env.MAISON_TOKEN = randomBytes(24).toString('base64url');
  appendFileSync(envPath, `\nMAISON_TOKEN=${env.MAISON_TOKEN}\n`);
  console.log('Nouveau jeton MAISON_TOKEN généré dans .env');
}

// Un jeton par personne : MAISON_TOKEN (Sam) et MAISON_TOKEN_<PRENOM>.
// Ajouter : node scripts/deploy-n8n.mjs --add Prénom   ·   Révoquer : supprimer la ligne dans .env puis relancer.
const addIdx = process.argv.indexOf('--add');
if (addIdx > 0) {
  const who = process.argv[addIdx + 1];
  if (!who) throw new Error('Usage : --add Prénom');
  const key = 'MAISON_TOKEN_' + who.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!env[key]) {
    env[key] = randomBytes(24).toString('base64url');
    appendFileSync(envPath, `${key}=${env[key]}\n`);
    console.log(`Jeton ${key} ajouté dans .env`);
  }
}
const tokens = Object.entries(env)
  .filter(([k]) => /^MAISON_TOKEN(_[A-Z0-9]+)?$/.test(k))
  .map(([k, v]) => ({ who: k === 'MAISON_TOKEN' ? 'SAM' : k.slice('MAISON_TOKEN_'.length), v }));

// Liste blanche : seuls ces modules / valeurs peuvent être pilotés depuis l'appli.
const cfg = JSON.parse(readFileSync(join(root, 'docs', 'config.json'), 'utf8'));
const settable = {};
const readable = new Set();
const allow = (id, vals) => { settable[id] = [...new Set([...(settable[id] || []), ...vals.map(String)])]; readable.add(String(id)); };
const read = (id) => id && readable.add(String(id));

for (const g of cfg.groups) for (const room of g.rooms) {
  read(room.temp);
  for (const it of room.items) {
    switch (it.type) {
      case 'light': allow(it.id, [it.on ?? 100, it.off ?? 0]); break;
      case 'shutter': allow(it.id, [0, 100, 240]); break;
      case 'switch': allow(it.id, [0, 100]); break;
      case 'garage': allow(it.id, [1, 2]); break;
      case 'action': allow(it.id, [it.value]); break;
      case 'door': case 'sensor': read(it.id); break;
      case 'tuya-switch': case 'tuya-meter': break; // gérés par la liste blanche Tuya (CFG.tu.switchable)
      case 'iaqua-exo': case 'iaqua-hp': break;     // gérés par la liste blanche iAquaLink (action iq.set)
      case 'yesno': allow(it.id, [0, 1]); break;
      case 'choice': allow(it.id, it.options.map((o) => o[0])); break;
      case 'state': read(it.id); break;
      default: throw new Error(`Type inconnu: ${it.type}`);
    }
  }
}
// Onglet Alarme : réglages (oui/non, choix) et états (sirènes)
for (const it of (cfg.alarm && cfg.alarm.items) || []) {
  if (it.type === 'yesno') allow(it.id, [0, 1]);
  else if (it.type === 'choice') allow(it.id, it.options.map((o) => o[0]));
  else read(it.id);
}
Object.values(cfg.heating).forEach((v) => typeof v === 'number' && read(v));
cfg.status.doors.forEach(read);
cfg.status.people.forEach((p) => read(typeof p === "object" ? p.id : p));
allow(cfg.dock.gate, [100]);
allow(cfg.dock.garage, [1, 2]);
allow(cfg.dock.alarm, [0, 12]);

const CODE_CFG = {
  user: env.EEDOMUS_API_USER,
  secret: env.EEDOMUS_API_SECRET,
  tokens: tokens.map((t) => t.v),
  settable,
  readable: [...readable],
  // Modules suivis dans les journaux (3 jours) de l'accueil
  logs: {
    people: cfg.status.people.map((p) => ({ id: typeof p === 'object' ? p.id : p, name: '' })),
    alarm: [{ id: cfg.status.alarm, name: 'Alarme' }],
    doors: cfg.status.doors.map((id) => ({ id, name: (cfg.groups.flatMap((g) => g.rooms).flatMap((r) => r.items).find((it) => it.id === id) || {}).name || 'Porte' }))
      .concat([{ id: cfg.dock.gate, name: 'Portail' }, { id: cfg.dock.garage, name: 'Porte de garage' }]),
    garage: cfg.dock.garage,
  },
  nt: env.NETATMO_REFRESH_TOKEN ? {
    id: env.NETATMO_CLIENT_ID,
    secret: env.NETATMO_CLIENT_SECRET,
    refresh: env.NETATMO_REFRESH_TOKEN,
    // L'empreinte change seulement si on refait l'autorisation : n8n garde sinon son propre jeton (Netatmo le fait tourner).
    seed: createHash('sha256').update(env.NETATMO_REFRESH_TOKEN.split('|')[0]).digest('hex').slice(0, 16),
  } : null,
  deployedAt: Date.now(),
  push: env.VAPID_PRIVATE ? { d: env.VAPID_PRIVATE, pub: env.VAPID_PUBLIC, sub: env.APP_URL || 'https://example.invalid/' } : null,
  iq: env.IAQUA_EMAIL ? { email: env.IAQUA_EMAIL, password: env.IAQUA_PASSWORD, exo: env.IAQUA_EXO_SN || null, hpm: env.IAQUA_HPM_SN || null } : null,
  im: env.IMOU_APP_ID ? { id: env.IMOU_APP_ID, secret: env.IMOU_APP_SECRET } : null,
  tu: env.TUYA_CLIENT_ID ? {
    id: env.TUYA_CLIENT_ID, secret: env.TUYA_CLIENT_SECRET, base: 'https://openapi.tuyaeu.com',
    devices: { sauna: env.TUYA_DEV_SAUNA, pac: env.TUYA_DEV_PAC, elec: env.TUYA_DEV_ELEC },
    switchable: ['sauna'],
  } : null,
};

const PUSH_LIB = readFileSync(join(root, 'scripts', 'webpush-lib.js'), 'utf8');
const code = `
const CFG = ${JSON.stringify(CODE_CFG)};
const helpers = this.helpers;
const req = $input.first().json;
let body = req.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
body = body || {};
const reply = (status, data) => [{ json: { status, data } }];
// Déclenchement par la minuterie (relevés d'énergie) : pas de requête HTTP, donc ni corps ni en-têtes.
const isCron = req.body === undefined && req.headers === undefined;
if (!isCron && body.action !== 'push.pending' && (!body.token || !CFG.tokens.includes(body.token))) return reply(401, { ok: false, error: 'unauthorized' });

const auth = 'api_user=' + encodeURIComponent(CFG.user) + '&api_secret=' + encodeURIComponent(CFG.secret);
async function eedomus(kind, query, attempt) {
  // Lecture : jusqu'à 2 nouveaux essais (0,6 s puis 1,5 s) si eedomus ne répond pas.
  // Commande (set) : rejouée UNIQUEMENT si l'erreur est un échec DNS (la requête n'est jamais partie),
  // pour ne jamais envoyer deux fois un ordre.
  attempt = attempt || 0;
  try {
    const raw = await helpers.httpRequest({
      url: 'https://api.eedomus.com/' + kind + '?' + auth + '&' + query,
      encoding: 'arraybuffer',
      json: false,
      timeout: 15000,
    });
    const r = JSON.parse(Buffer.from(raw).toString('latin1'));
    if (kind === 'get' && r.success !== 1 && attempt < 2) throw new Error('eedomus success=' + r.success);
    return r;
  } catch (e) {
    const dns = /getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(String(e && (e.message || e.code) || ''));
    if (attempt >= 2 || (kind !== 'get' && !dns)) throw e;
    await new Promise((ok) => setTimeout(ok, attempt === 0 ? 600 : 1500));
    return eedomus(kind, query, attempt + 1);
  }
}

// ---------------- Porte de garage : état mémorisé (pas de capteur) ----------------
// Par défaut fermée. Mis à jour par les commandes (appli ou eedomus) et par les corrections manuelles.
function localNow() {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}
function garageSet(state, src) {
  const G = $getWorkflowStaticData('global');
  G.garage = { state, date: localNow(), src };
  G.garageLog = [{ state, date: G.garage.date, src }].concat(G.garageLog || []).slice(0, 40);
}
function garageState(events) {
  const G = $getWorkflowStaticData('global');
  let g = G.garage || { state: 'closed', date: '', src: 'défaut' };
  // commandes passées par eedomus (appli eedomus, scènes…) plus récentes que l'état mémorisé
  const cmd = (events || []).filter((e) => String(e.id) === String(CFG.logs.garage) && /ouverture|fermeture/i.test(e.text)).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  // la commande du garage est un contact bref (chaque commande fait bouger la porte, dans un sens ou dans l'autre) : état à vérifier
  if (cmd && cmd.date > g.date) { g = { state: 'unknown', date: cmd.date, src: 'commande' }; garageCheckSoon(); }
  const cam = G.garageCam || {}, refs = G.garageRefs || [];
  return Object.assign({}, g, { log: G.garageLog || [],
    cam: { at: cam.at || null, state: cam.state || null, margin: cam.margin ?? null, today: (G.garageCamCount && G.garageCamCount.n) || 0, err: G.garageCamErr ? G.garageCamErr.code + ' ' + G.garageCamErr.msg : null,
      refs: { open: refs.filter((r) => r.state === 'open').length, closed: refs.filter((r) => r.state === 'closed').length } } });
}
// Demander des photos de contrôle du garage juste après une commande (puis on insiste tant que l'état n'est pas sûr)
function garageCheckSoon() {
  const G = $getWorkflowStaticData('global');
  G.garageDues = [Date.now() + 20000, Date.now() + 45000, Date.now() + 75000];
  G.garageRetry = 8;
}
// Faut-il prendre une photo maintenant ? Si oui, renvoie l'adresse d'une photo toute fraîche de la caméra du garage
async function garageCamDue() {
  if (!CFG.im) return null;
  const G = $getWorkflowStaticData('global');
  const now = Date.now(), last = (G.garageCam && G.garageCam.tryAt) || 0;
  const dues = (G.garageDues || []).filter((t) => t <= now);
  // Photo toutes les minutes ; si Imou se met en erreur (quota…), on ralentit tout seul : 3 min, puis 10 min
  const errs = (G.garageCamErr && G.garageCamErr.n) || 0, every = errs >= 6 ? 10 : errs >= 2 ? 3 : 1;
  if (!dues.length && now - last < every * 60000 - 5000) return null;
  G.garageDues = (G.garageDues || []).filter((t) => t > now);
  G.garageCam = Object.assign({}, G.garageCam || {}, { tryAt: now });
  const d = (await imDevices()).find((x) => String(x.name).toLowerCase() === 'garage' && x.online);
  if (!d) return null;
  const r = await im('setDeviceSnapEnhanced', { deviceId: d.deviceId, channelId: d.channelId });
  const day = localNow().slice(0, 10);
  if (!G.garageCamCount || G.garageCamCount.day !== day) G.garageCamCount = { day, n: 0 };
  G.garageCamCount.n++; // compteur du jour (pour surveiller le quota Imou)
  if (r.code !== '0' || !r.data || !r.data.url) { G.garageCamErr = { n: ((G.garageCamErr && G.garageCamErr.n) || 0) + 1, code: r.code, msg: String(r.msg || '').slice(0, 80), at: now }; return null; }
  G.garageCamErr = null;
  await new Promise((ok) => setTimeout(ok, 2500)); // le temps que la photo soit disponible
  return r.data.url;
}

// ---------------- Netatmo ----------------
const SD = $getWorkflowStaticData('global');
// Nouveau déploiement : on vide les données en cache (formats changés), on garde les jetons d'accès.
if (SD.deployedAt !== CFG.deployedAt) {
  ['ntHomes', 'ntHeat', 'ntCams', 'imDev', 'imLive', 'imSnap', 'imRec', 'tuState', 'tuSpec', 'iqState', 'ntHist', 'ntGraph', 'hist'].forEach((k) => { delete SD[k]; });
  SD.deployedAt = CFG.deployedAt;
}
function fail(httpStatus, code, detail) { const e = new Error(code); e.httpStatus = httpStatus; e.code = code; e.detail = detail; return e; }
function parse(x) { return typeof x === 'string' ? JSON.parse(x) : x; }

async function ntToken(force) {
  if (!SD.nt || SD.nt.seed !== CFG.nt.seed) SD.nt = { seed: CFG.nt.seed, refresh: CFG.nt.refresh, access: null, exp: 0 };
  if (!force && SD.nt.access && SD.nt.exp > Date.now() + 60000) return SD.nt.access;
  const form = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(SD.nt.refresh) +
    '&client_id=' + encodeURIComponent(CFG.nt.id) + '&client_secret=' + encodeURIComponent(CFG.nt.secret);
  let j;
  try {
    j = parse(await helpers.httpRequest({ method: 'POST', url: 'https://api.netatmo.com/oauth2/token',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: form, json: false, timeout: 15000 }));
  } catch (e) { throw fail(502, 'netatmo_auth', String(e.message || e)); }
  if (!j.access_token) throw fail(502, 'netatmo_auth', j);
  SD.nt.access = j.access_token;
  if (j.refresh_token) SD.nt.refresh = j.refresh_token;
  SD.nt.exp = Date.now() + (j.expires_in || 10800) * 1000;
  return SD.nt.access;
}
async function nt(method, path, params, retry) {
  const tok = await ntToken(false);
  const qs = Object.entries(params || {}).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  try {
    const opts = { method, headers: { Authorization: 'Bearer ' + tok }, json: false, timeout: 15000 };
    if (method === 'GET') opts.url = 'https://api.netatmo.com/api/' + path + (qs ? '?' + qs : '');
    else { opts.url = 'https://api.netatmo.com/api/' + path; opts.body = qs; opts.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'; }
    return parse(await helpers.httpRequest(opts));
  } catch (e) {
    const st = e.httpCode || (e.response && e.response.status) || (e.cause && e.cause.status);
    if (!retry && (String(st) === '403' || String(st) === '401')) { SD.nt.access = null; await ntToken(true); return nt(method, path, params, true); }
    throw fail(502, 'netatmo', String(e.message || e));
  }
}
// POST avec un corps JSON (plannings : zones et timetable sont des tableaux)
async function ntJson(path, obj, retry) {
  const tok = await ntToken(false);
  try {
    return parse(await helpers.httpRequest({ method: 'POST', url: 'https://api.netatmo.com/api/' + path, json: false, timeout: 20000,
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }));
  } catch (e) {
    const st = e.httpCode || (e.response && e.response.status) || (e.cause && e.cause.status);
    if (!retry && (String(st) === '403' || String(st) === '401')) { SD.nt.access = null; await ntToken(true); return ntJson(path, obj, true); }
    let detail = String(e.message || e);
    try { const b = e.response && (e.response.body || e.response.data); if (b) detail += ' ' + (typeof b === 'string' ? b : JSON.stringify(b)); } catch (x) {}
    throw fail(502, 'netatmo', detail);
  }
}
// Vérifie un planning envoyé par l'appli avant de l'écrire chez Netatmo
function ntCheckSchedule(H, s) {
  const roomIds = H.heat.rooms.map((r) => String(r.id));
  if (!s || typeof s !== 'object') return 'planning manquant';
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 30) return 'nom invalide';
  if (!Array.isArray(s.zones) || !s.zones.length || s.zones.length > 12) return 'ambiances invalides';
  const zoneIds = [];
  for (const z of s.zones) {
    if (!Number.isInteger(z.id) || ![0, 1, 4, 5, 8].includes(z.type)) return 'ambiance invalide';
    if (z.name != null && (typeof z.name !== 'string' || z.name.length > 30)) return "nom d'ambiance invalide";
    if (!Array.isArray(z.rooms)) return 'pièces invalides';
    for (const r of z.rooms) {
      if (!roomIds.includes(String(r.id))) return 'pièce inconnue';
      const t = Number(r.t);
      if (!(t >= 5 && t <= 30) || (t * 2) % 1 !== 0) return 'température hors limites (5 à 30 °C)';
    }
    zoneIds.push(z.id);
  }
  if (!Array.isArray(s.timetable) || !s.timetable.length || s.timetable.length > 300) return 'plages invalides';
  let prev = -1;
  for (const t of s.timetable) {
    if (!Number.isInteger(t.o) || t.o < 0 || t.o > 10079 || t.o <= prev) return 'horaires invalides';
    if (!zoneIds.includes(t.z)) return 'plage sans ambiance';
    prev = t.o;
  }
  if (s.timetable[0].o !== 0) return 'le planning doit commencer lundi à 00:00';
  return null;
}
function ntScheduleBody(H, s) {
  return {
    home_id: H.heat.id, name: s.name.trim(),
    hg_temp: s.hg != null ? Number(s.hg) : 7, away_temp: s.away != null ? Number(s.away) : 12,
    zones: s.zones.map((z) => {
      // Format d'écriture Netatmo : rooms_temp [{ room_id, temp }] (différent du format de lecture)
      const o = { id: z.id, type: z.type, rooms_temp: z.rooms.map((r) => ({ room_id: String(r.id), temp: Number(r.t) })) };
      if (z.name) o.name = z.name;
      return o;
    }),
    timetable: s.timetable.map((t) => ({ zone_id: t.z, m_offset: t.o })),
  };
}

async function ntHomes() {
  if (SD.ntHomes && SD.ntHomes.at > Date.now() - 3600000) return SD.ntHomes;
  const hd = await nt('GET', 'homesdata', {});
  const homes = (hd.body && hd.body.homes) || [];
  const heat = homes.find((h) => h.therm_mode && (h.rooms || []).length);
  const cams = [];
  homes.forEach((h) => (h.modules || []).forEach((m) => { if (['NOC', 'NACamera', 'NDB', 'NSD'].includes(m.type)) cams.push({ home: h.id, id: m.id, name: m.name, type: m.type }); }));
  SD.ntHomes = {
    at: Date.now(),
    heat: heat ? { id: heat.id, tz: heat.timezone || 'Europe/Paris', rooms: heat.rooms.filter((r) => (r.module_ids || []).length).map((r) => ({ id: r.id, name: r.name, type: r.type })),
      // pièces équipées du thermostat (la chaudière y chauffe directement)
      thermRooms: (heat.modules || []).filter((m) => m.type === 'NATherm1' && m.room_id).map((m) => m.room_id),
      therm: (heat.modules || []).filter((m) => m.type === 'NATherm1').map((m) => ({ id: m.id, room: m.room_id, bridge: m.bridge || null })),
      schedules: (heat.schedules || []).filter((s) => !s.type || s.type === 'therm').map((s) => ({
        id: s.id, name: s.name, selected: !!s.selected, isDefault: !!s.default,
        hg: s.hg_temp ?? null, away: s.away_temp ?? null,
        timetable: (s.timetable || []).map((t) => ({ z: t.zone_id, o: t.m_offset })).sort((a, b) => a.o - b.o),
        zones: (s.zones || []).map((z) => ({ id: z.id, name: z.name || null, type: z.type,
          rooms: (z.rooms || []).map((r) => ({ id: r.id, t: r.therm_setpoint_temperature ?? null })) })),
      })) } : null,
    cams,
  };
  return SD.ntHomes;
}
// Créneau en cours du planning : nom de la zone et heure du prochain changement (heure locale de la maison).
const ZONE_TYPE = { 0: 'Confort', 1: 'Nuit', 5: 'Éco', 4: 'Personnalisé', 8: 'Confort+' };
function ntSlot(sched, tz) {
  const tt = sched.timetable || [];
  if (!tt.length) return null;
  const parts = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  const now = day * 1440 + Number(parts.hour) * 60 + Number(parts.minute);
  let cur = tt[tt.length - 1];
  for (const t of tt) if (t.o <= now) cur = t;
  let next = null;
  for (let i = 0; i < tt.length * 2 && !next; i++) {
    const t = tt[i % tt.length], off = t.o + (i >= tt.length ? 10080 : 0);
    if (off > now && t.z !== cur.z) next = { z: t.z, o: off };
  }
  const zone = (sched.zones || []).find((z) => z.id === cur.z) || {};
  const out = { zone: zone.name || ZONE_TYPE[zone.type] || null, until: null, untilDay: null };
  if (next) {
    const o = next.o % 10080, d = Math.floor(o / 1440), mins = o % 1440;
    out.until = String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
    const diff = (d - day + 7) % 7;
    out.untilDay = next.o - now >= 1440 * 6 ? 'week' : diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'][d];
  }
  return out;
}
async function ntHeating(fresh) {
  if (!fresh && SD.ntHeat && SD.ntHeat.at > Date.now() - 20000) return SD.ntHeat.data;
  const H = await ntHomes();
  if (!H.heat) throw fail(404, 'no_heating');
  const st = await nt('GET', 'homestatus', { home_id: H.heat.id });
  const home = (st.body && st.body.home) || {};
  const byId = {}; (home.rooms || []).forEach((r) => { byId[r.id] = r; });
  // Chaudière : le thermostat (NATherm1) indique si la chaudière est en marche (boiler_status)
  const mods = home.modules || [];
  const boiler = mods.some((m) => m.boiler_status === true);
  const boilerKnown = mods.some((m) => Object.prototype.hasOwnProperty.call(m, 'boiler_status'));
  const thermRooms = (H.heat.thermRooms || []).map(String);
  const sel = H.heat.schedules.find((s) => s.selected) || null;
  const data = {
    ok: true, home: H.heat.id,
    schedule: sel ? sel.name : null,
    scheduleId: sel ? sel.id : null,
    schedules: H.heat.schedules.map((s) => ({ id: s.id, name: s.name })),
    slot: sel ? ntSlot(sel, H.heat.tz) : null,
    rooms: H.heat.rooms.map((r) => {
      const s = byId[r.id] || {};
      const power = s.heating_power_request ?? null;
      return { id: r.id, name: r.name, temp: s.therm_measured_temperature ?? null, setpoint: s.therm_setpoint_temperature ?? null,
        mode: s.therm_setpoint_mode || null, end: s.therm_setpoint_end_time || null, power,
        heating: (power || 0) > 0 || (boiler && thermRooms.includes(String(r.id))), open_window: !!s.open_window };
    }),
    boiler, boilerKnown,
    at: new Date().toISOString(),
  };
  // Mode général de la maison : déduit des pièces (away / hg / schedule)
  const modes = data.rooms.map((r) => r.mode);
  data.mode = modes.length && modes.every((m) => m === 'away') ? 'away' : modes.length && modes.every((m) => m === 'hg') ? 'hg' : 'schedule';
  SD.ntHeat = { at: Date.now(), data };
  return data;
}
async function ntCameras(fresh) {
  if (!fresh && SD.ntCams && SD.ntCams.at > Date.now() - 30000) return SD.ntCams.data;
  const H = await ntHomes();
  const out = [], events = [], vpnBy = {};
  const homeIds = [...new Set(H.cams.map((c) => c.home))];
  for (const hid of homeIds) {
    const st = await nt('GET', 'homestatus', { home_id: hid });
    const mods = {}; ((st.body && st.body.home && st.body.home.modules) || []).forEach((m) => { mods[m.id] = m; });
    H.cams.filter((c) => c.home === hid).forEach((c) => {
      const m = mods[c.id] || {}, vpn = m.vpn_url || null;
      vpnBy[c.id] = vpn;
      out.push({ id: c.id, name: c.name, type: c.type, on: m.monitoring === 'on', status: m.monitoring || m.status || null,
        light: m.floodlight || null, live: vpn ? vpn + '/live/files/high/index.m3u8' : null, liveLow: vpn ? vpn + '/live/files/low/index.m3u8' : null,
        snapshot: vpn ? vpn + '/live/snapshot_720.jpg' : null });
    });
    try {
      const ev = await nt('GET', 'getevents', { home_id: hid, size: 30 });
      ((ev.body && ev.body.home && ev.body.home.events) || []).forEach((e) => {
        const sub = (e.subevents || [])[0] || {};
        const vpn = vpnBy[e.module_id];
        // Clip vidéo de l'événement, lu depuis la carte SD de la caméra (tant que la caméra est en ligne)
        const video = vpn && e.video_id && (!e.video_status || e.video_status === 'available') ? vpn + '/vod/' + e.video_id + '/files/high/index.m3u8' : null;
        events.push({ id: e.id, camera: e.module_id, time: e.time, type: sub.type || e.type, message: e.message || null,
          snapshot: (sub.snapshot && sub.snapshot.url) || (e.snapshot && e.snapshot.url) || null, video });
      });
    } catch (e) { /* événements facultatifs */ }
  }
  events.sort((a, b) => b.time - a.time);
  const data = { ok: true, cameras: out, events: events.slice(0, 15), at: new Date().toISOString() };
  SD.ntCams = { at: Date.now(), data };
  return data;
}
// ---------------- Imou (caméras) ----------------
// Quotas gratuits : 30 000 requêtes et 2 Go de vidéo. Photos seulement à la demande, tout est mis en cache.
function md5(str) {
  // MD5 en JavaScript pur (le module crypto peut être interdit dans le nœud Code de n8n).
  function rh(n) { let s = ''; for (let j = 0; j <= 3; j++) s += ((n >> (j * 8 + 4)) & 0x0F).toString(16) + ((n >> (j * 8)) & 0x0F).toString(16); return s; }
  function ad(x, y) { const l = (x & 0xFFFF) + (y & 0xFFFF); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xFFFF); }
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cm(q, a, b, x, s, t) { return ad(rl(ad(ad(a, q), ad(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cm((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cm((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cm(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cm(c ^ (b | ~d), a, b, x, s, t); }
  const u = unescape(encodeURIComponent(str)), nb = ((u.length + 8) >> 6) + 1, x = new Array(nb * 16).fill(0);
  for (let i = 0; i < u.length; i++) x[i >> 2] |= u.charCodeAt(i) << ((i % 4) * 8);
  x[u.length >> 2] |= 0x80 << ((u.length % 4) * 8); x[nb * 16 - 2] = u.length * 8;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586); c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426); c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417); c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101); c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632); c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083); c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690); c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784); c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463); c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353); c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222); c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835); c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415); c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606); c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744); c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379); c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = ad(a, oa); b = ad(b, ob); c = ad(c, oc); d = ad(d, od);
  }
  return rh(a) + rh(b) + rh(c) + rh(d);
}
function nonceId() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => { const r = Math.random() * 16 | 0; return (ch === 'x' ? r : (r & 3 | 8)).toString(16); }); }
async function imCall(method, params) {
  const time = Math.floor(Date.now() / 1000), nonce = nonceId();
  const sign = md5('time:' + time + ',nonce:' + nonce + ',appSecret:' + CFG.im.secret);
  const base = (SD.im && SD.im.domain) || 'https://openapi-fk.easy4ip.com';
  let r;
  try {
    r = parse(await helpers.httpRequest({ method: 'POST', url: base + '/openapi/' + method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: { ver: '1.0', appId: CFG.im.id, sign, time, nonce }, id: nonce, params }), json: false, timeout: 20000 }));
  } catch (e) { throw fail(502, 'imou', String(e.message || e)); }
  return r.result || r;
}
async function imToken(force) {
  if (!SD.im) SD.im = {};
  if (!force && SD.im.token && SD.im.exp > Date.now() + 600000) return SD.im.token;
  const r = await imCall('accessToken', {});
  if (r.code !== '0') throw fail(502, 'imou_auth', r.msg);
  SD.im.token = r.data.accessToken;
  SD.im.exp = Date.now() + Math.min(Number(r.data.expireTime || 259200), 259200) * 1000;
  if (r.data.currentDomain) SD.im.domain = String(r.data.currentDomain).replace(/:443$/, '');
  return SD.im.token;
}
async function im(method, params, retry) {
  const token = await imToken(false);
  const r = await imCall(method, Object.assign({ token }, params));
  if (!retry && (r.code === 'TK1002' || r.code === 'TK1004' || /token/i.test(r.msg || '') && r.code !== '0')) { await imToken(true); return im(method, params, true); }
  return r;
}
async function imDevices() {
  if (SD.imDev && SD.imDev.at > Date.now() - 600000) return SD.imDev.list;
  const r = await im('listDeviceDetailsByPage', { page: 1, pageSize: 50 });
  if (r.code !== '0') throw fail(502, 'imou', r.msg);
  const list = [];
  ((r.data && r.data.deviceList) || []).forEach((d) => (d.channelList || d.channels || [{ channelId: '0' }]).forEach((c) => {
    list.push({ id: d.deviceId + ':' + (c.channelId || '0'), deviceId: d.deviceId, channelId: String(c.channelId || '0'),
      name: d.deviceName || c.channelName || d.deviceId, model: d.deviceModel || null,
      online: (c.channelStatus || d.deviceStatus) === 'online' });
  }));
  SD.imDev = { at: Date.now(), list };
  return list;
}
async function imLive(d) {
  SD.imLive = SD.imLive || {};
  const c = SD.imLive[d.id];
  if (c && c.at > Date.now() - 1800000) return c;
  const p = { deviceId: d.deviceId, channelId: d.channelId };
  let info = await im('getLiveStreamInfo', p);
  if (info.code !== '0') { await im('bindDeviceLive', Object.assign({ streamId: 1 }, p)); info = await im('getLiveStreamInfo', p); }
  const streams = (info.data && info.data.streams) || [];
  const pick = (sid) => { const s = streams.find((x) => Number(x.streamId) === sid && /^https|proto=https/.test(x.hls)); return s ? s.hls : null; };
  const out = { at: Date.now(), sd: pick(1), hd: pick(0) };
  SD.imLive[d.id] = out;
  return out;
}
async function imSnap(d) {
  SD.imSnap = SD.imSnap || {};
  const c = SD.imSnap[d.id];
  if (c && c.at > Date.now() - 120000) return c.url;
  const r = await im('setDeviceSnapEnhanced', { deviceId: d.deviceId, channelId: d.channelId });
  const url = r.code === '0' && r.data ? r.data.url : null;
  SD.imSnap[d.id] = { at: Date.now(), url };
  return url;
}
async function imou(b) {
  if (!CFG.im) throw fail(503, 'imou_not_configured');
  if (b.action === 'im.cameras') {
    const devs = await imDevices();
    const cams = [];
    for (const d of devs) {
      const cam = { id: d.id, name: d.name, model: d.model, on: d.online, live: null, liveHd: null, snapshot: null };
      if (d.online) {
        try { const l = await imLive(d); cam.live = l.sd; cam.liveHd = l.hd; } catch (e) {}
        if (b.snaps) { try { cam.snapshot = await imSnap(d); } catch (e) {} }
      }
      cams.push(cam);
    }
    return { ok: true, cameras: cams, at: new Date().toISOString() };
  }
  // Enregistrements de la carte SD d'une caméra, pour une journée (format AAAA-MM-JJ)
  if (b.action === 'im.records') {
    const d = (await imDevices()).find((x) => x.id === b.cam);
    if (!d || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(b.date))) throw fail(403, 'not_allowed');
    SD.imRec = SD.imRec || {};
    const key = d.id + '|' + b.date, c = SD.imRec[key];
    if (c && c.at > Date.now() - 60000) return c.data;
    const p = { deviceId: d.deviceId, channelId: d.channelId, beginTime: b.date + ' 00:00:00', endTime: b.date + ' 23:59:59', type: 'All' };
    const all = [];
    for (let page = 0; page < 4; page++) {
      const r = await im('queryLocalRecords', Object.assign({ queryRange: (page * 100 + 1) + '-' + (page * 100 + 100) }, p));
      if (r.code !== '0') { if (page === 0 && !/not.*exist|no.*record/i.test(r.msg || '')) throw fail(502, 'imou', r.msg); break; }
      const recs = (r.data && (r.data.records || r.data.recordList)) || [];
      recs.forEach((x) => all.push({ begin: x.beginTime, end: x.endTime, type: x.type || null, size: x.fileLength || null }));
      if (recs.length < 100) break;
    }
    all.sort((x, y) => (x.begin < y.begin ? 1 : -1));
    const data = { ok: true, cam: d.id, date: b.date, records: all };
    SD.imRec[key] = { at: Date.now(), data };
    Object.keys(SD.imRec).forEach((k) => { if (SD.imRec[k].at < Date.now() - 600000) delete SD.imRec[k]; });
    return data;
  }
  // Lien de lecture HLS d'un enregistrement (valable quelques minutes)
  if (b.action === 'im.playback') {
    const d = (await imDevices()).find((x) => x.id === b.cam);
    const re = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/;
    if (!d || !re.test(String(b.begin)) || !re.test(String(b.end)) || String(b.begin).slice(0, 10) !== String(b.end).slice(0, 10)) throw fail(403, 'not_allowed');
    const r = await im('createDeviceRecordHls', { deviceId: d.deviceId, channelId: d.channelId, beginTime: b.begin, endTime: b.end, recordType: 'localRecord', streamId: b.sd ? 1 : 0 });
    if (r.code !== '0' || !r.data || !r.data.url) throw fail(502, 'imou', r.msg);
    return { ok: true, url: r.data.url };
  }
  throw fail(400, 'unknown_action');
}

// ---------------- Smart Life / Tuya ----------------
function sha256Bytes(bytes) {
  // SHA-256 en JavaScript pur (le module crypto peut être interdit dans le nœud Code de n8n).
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const l = bytes.length, withPad = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(withPad);
  m.set(bytes); m[l] = 0x80;
  const bits = l * 8; for (let i = 0; i < 8; i++) m[withPad - 1 - i] = Math.floor(bits / Math.pow(2, 8 * i)) & 0xff;
  const w = new Array(64);
  for (let o = 0; o < withPad; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = (m[o + 4 * i] << 24) | (m[o + 4 * i + 1] << 16) | (m[o + 4 * i + 2] << 8) | m[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = new Uint8Array(32);
  H.forEach((v, i) => { out[4 * i] = v >>> 24; out[4 * i + 1] = (v >>> 16) & 0xff; out[4 * i + 2] = (v >>> 8) & 0xff; out[4 * i + 3] = v & 0xff; });
  return out;
}
function utf8(s) { const u = unescape(encodeURIComponent(s)), b = new Uint8Array(u.length); for (let i = 0; i < u.length; i++) b[i] = u.charCodeAt(i); return b; }
function hex(b) { return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(''); }
function sha256hex(s) { return hex(sha256Bytes(utf8(s))); }
function hmac256hex(key, msg) {
  let k = utf8(key); if (k.length > 64) k = sha256Bytes(k);
  const kp = new Uint8Array(64); kp.set(k);
  const ip = kp.map((x) => x ^ 0x36), op = kp.map((x) => x ^ 0x5c), mb = utf8(msg);
  const inner = new Uint8Array(64 + mb.length); inner.set(ip); inner.set(mb, 64);
  const ih = sha256Bytes(inner), outer = new Uint8Array(96); outer.set(op); outer.set(ih, 64);
  return hex(sha256Bytes(outer));
}
${PUSH_LIB}
function pushKey(endpoint) { return sha256hex(String(endpoint)).slice(0, 16); }
// Envoie une notification à tous les iPhones abonnés (ou à un seul). Le texte attend dans une file, l'iPhone le récupère.
async function pushNotify(item, onlyKey) {
  if (!CFG.push) return 0;
  SD.push = SD.push || { subs: {}, delay: 2 };
  let sent = 0;
  for (const k of Object.keys(SD.push.subs)) {
    if (onlyKey && k !== onlyKey) continue;
    const s = SD.push.subs[k];
    s.q = (s.q || []).filter((x) => x.at > Date.now() - 3600000 && x.tag !== item.tag).concat([Object.assign({ at: Date.now() }, item)]).slice(-5);
    try {
      const r = await helpers.httpRequest({ method: 'POST', url: s.endpoint, body: '', json: false, returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 10000,
        headers: { TTL: '3600', Urgency: 'high', Authorization: 'vapid t=' + vapidJwt(s.endpoint, CFG.push) + ', k=' + CFG.push.pub, 'Content-Length': '0' } });
      const st = r.statusCode;
      if (st === 404 || st === 410) delete SD.push.subs[k];
      else if (st >= 200 && st < 300) { sent++; s.lastOk = Date.now(); s.lastErr = null; }
      else s.lastErr = st + ' ' + (typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '')).slice(0, 120);
    } catch (e) { s.lastErr = String(e && e.message || e).slice(0, 120); }
  }
  return sent;
}
// Alerte « porte de garage ouverte depuis plus de N minutes » (vérifiée toutes les 30 s), rappel toutes les 30 min, puis « refermée »
async function garageAlert() {
  if (!CFG.push || !SD.push || !Object.keys(SD.push.subs || {}).length || !SD.garage) return;
  const g = SD.garage, A = SD.garageAlert || {};
  const ms = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');
  const hm = (s) => String(s).slice(11, 16).replace(':', 'h');
  const dur = (m) => (m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0'));
  if (g.state === 'open') {
    const mins = Math.floor((ms(localNow()) - ms(g.date)) / 60000), delay = SD.push.delay || 2;
    if (mins < delay) return;
    if (A.for !== g.date) {
      SD.garageAlert = { for: g.date, at: Date.now() };
      await pushNotify({ tag: 'garage', title: 'Porte de garage ouverte', body: 'Ouverte depuis ' + dur(mins) + ' (à ' + hm(g.date) + ')', badge: 1 });
    } else if (Date.now() - A.at > 30 * 60000) {
      A.at = Date.now(); SD.garageAlert = A;
      await pushNotify({ tag: 'garage', title: 'Porte de garage toujours ouverte', body: 'Ouverte depuis ' + dur(mins) + ' (à ' + hm(g.date) + ')', badge: 1 });
    }
  } else if (g.state === 'closed' && A.for) {
    SD.garageAlert = {};
    await pushNotify({ tag: 'garage', title: 'Porte de garage fermée', body: 'Refermée à ' + hm(g.date), badge: 0 });
  }
}
async function tuReq(method, path, token, body) {
  body = body || '';
  const t = String(Date.now()), nonce = nonceId();
  const sts = [method, sha256hex(body), '', path].join(String.fromCharCode(10));
  const sign = hmac256hex(CFG.tu.secret, CFG.tu.id + (token || '') + t + nonce + sts).toUpperCase();
  const headers = { client_id: CFG.tu.id, sign, t, nonce, sign_method: 'HMAC-SHA256', 'Content-Type': 'application/json' };
  if (token) headers.access_token = token;
  let r;
  try { r = parse(await helpers.httpRequest({ method, url: CFG.tu.base + path, headers, body: body || undefined, json: false, timeout: 15000 })); }
  catch (e) { throw fail(502, 'tuya', String(e.message || e)); }
  return r;
}
async function tuToken(force) {
  SD.tu = SD.tu || {};
  if (!force && SD.tu.token && SD.tu.exp > Date.now() + 120000) return SD.tu.token;
  const r = await tuReq('GET', '/v1.0/token?grant_type=1', '', '');
  if (!r.success) throw fail(502, 'tuya_auth', r.msg);
  SD.tu.token = r.result.access_token; SD.tu.exp = Date.now() + r.result.expire_time * 1000;
  return SD.tu.token;
}
async function tu(method, path, body, retry) {
  const r = await tuReq(method, path, await tuToken(false), body);
  if (!r.success && !retry && (r.code === 1010 || r.code === 1011)) { await tuToken(true); return tu(method, path, body, true); }
  if (!r.success) throw fail(502, 'tuya', r.code + ' ' + r.msg);
  return r.result;
}
async function tuScales(id) {
  SD.tuSpec = SD.tuSpec || {};
  if (SD.tuSpec[id] && SD.tuSpec[id].at > Date.now() - 86400000) return SD.tuSpec[id].s;
  const spec = await tu('GET', '/v1.0/devices/' + id + '/specifications');
  const s = {};
  (spec.status || []).forEach((x) => { try { const v = JSON.parse(x.values); if (v.scale !== undefined) s[x.code] = v.scale; } catch (e) {} });
  SD.tuSpec[id] = { at: Date.now(), s };
  return s;
}
async function tuState(fresh) {
  if (!fresh && SD.tuState && SD.tuState.at > Date.now() - 30000) return SD.tuState.data;
  const keys = Object.keys(CFG.tu.devices).filter((k) => CFG.tu.devices[k]);
  const ids = keys.map((k) => CFG.tu.devices[k]);
  const list = await tu('GET', '/v1.0/iot-03/devices/status?device_ids=' + ids.join(','));
  const devices = {};
  for (const k of keys) {
    const id = CFG.tu.devices[k], row = (list || []).find((x) => x.id === id) || { status: [] };
    const st = {}; (row.status || []).forEach((x) => { st[x.code] = x.value; });
    const sc = await tuScales(id), sv = (code) => st[code] === undefined ? null : st[code] / Math.pow(10, sc[code] || 0);
    const d = { on: typeof st.switch === 'boolean' ? st.switch : (typeof st.switch_1 === 'boolean' ? st.switch_1 : null), power: null, voltage: null, current: null, energy: null };
    if (st.cur_power !== undefined) { d.power = sv('cur_power'); d.voltage = sv('cur_voltage'); d.current = st.cur_current === undefined ? null : sv('cur_current') / 1000; }
    if (st.phase_a) { try { const p = JSON.parse(st.phase_a); d.power = Math.round(p.power * 1000); d.voltage = p.voltage; d.current = p.electricCurrent; } catch (e) {} }
    if (st.forward_energy_total !== undefined) d.energy = sv('forward_energy_total');
    d.countdown = st.countdown_1 || 0;
    devices[k] = d;
  }
  const data = { ok: true, devices, at: new Date().toISOString() };
  SD.tuState = { at: Date.now(), data };
  enRecord(devices);
  return data;
}

// ---- Relevés d'énergie (historique maison, car le service « Statistiques » de Tuya n'est pas activé) ----
// Compteurs : index kWh (forward_energy_total). Sauna : énergie intégrée à partir de la puissance mesurée.
// SD.en[clé] = { h: { AAAAMMJJHH: index au début de l'heure }, d: { AAAAMMJJ: index au début du jour }, last, t, p, acc }
function enKey(ts) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ts)).forEach((x) => { p[x.type] = x.value; });
  return p.year + p.month + p.day + p.hour;
}
function enRecord(devices) {
  SD.en = SD.en || {};
  const now = Date.now(), hk = enKey(now), dk = hk.slice(0, 8);
  const hCut = enKey(now - 9 * 86400000), dCut = enKey(now - 800 * 86400000).slice(0, 8);
  Object.keys(devices).forEach((k) => {
    const d = devices[k], e = SD.en[k] = SD.en[k] || { h: {}, d: {}, acc: 0, t: 0, p: null, last: null };
    let idx;
    if (d.energy != null) idx = d.energy;
    else {
      // intégration trapèze de la puissance (W) entre deux relevés espacés de moins de 20 min
      if (e.t && e.p != null) { const dt = (now - e.t) / 3600000; if (dt > 0 && dt < 0.34) e.acc += ((e.p + (d.power || 0)) / 2) / 1000 * dt; }
      idx = Math.round(e.acc * 10000) / 10000;
    }
    e.t = now; e.p = d.power || 0; e.last = idx;
    if (e.h[hk] === undefined) e.h[hk] = idx;
    if (e.d[dk] === undefined) e.d[dk] = idx;
    Object.keys(e.h).forEach((x) => { if (x < hCut) delete e.h[x]; });
    Object.keys(e.d).forEach((x) => { if (x < dCut) delete e.d[x]; });
  });
}
async function enSample() {
  // Minuterie toutes les 5 min : relevé si le sauna chauffe, sinon au plus tous les 14 min (forfait Tuya préservé).
  if (!CFG.tu) return;
  const sauna = SD.en && SD.en.sauna, heating = sauna && sauna.p > 50;
  const lastAt = SD.tuState ? SD.tuState.at : 0;
  if (!heating && Date.now() - lastAt < 14 * 60000) return;
  if (heating && Date.now() - lastAt < 55000) return; // la minuterie tourne toutes les 30 s : relevé au plus 1 fois par minute
  await tuState(true);
}
function enSeries(k) {
  const e = (SD.en || {})[k];
  if (!e) return { hours: [], days: [], since: null };
  const diff = (obj) => {
    const keys = Object.keys(obj).sort();
    return keys.map((key, i) => ({ k: key, kwh: Math.max(0, Math.round(((i + 1 < keys.length ? obj[keys[i + 1]] : e.last) - obj[key]) * 1000) / 1000) }));
  };
  const days = diff(e.d), hours = diff(e.h);
  return { hours, days, since: Object.keys(e.d).sort()[0] || null, index: e.last };
}

// ---------------- iAquaLink (Zodiac / Fluidra) : électrolyseur eXO et pompe à chaleur ----------------
// API non officielle (celle de l'appli iAquaLink, documentée par l'intégration Home Assistant iaqualink-py).
const IQ_KEY = 'EOOEMOW4YR6QNB07', IQ_UA = 'okhttp/3.14.7';
async function iqLogin(force) {
  SD.iq = SD.iq || {};
  if (!force && SD.iq.idt && SD.iq.exp > Date.now() + 120000) return SD.iq.idt;
  let L;
  try {
    L = parse(await helpers.httpRequest({ method: 'POST', url: 'https://prod.zodiac-io.com/users/v1/login', json: false, timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'User-Agent': IQ_UA },
      body: JSON.stringify({ api_key: IQ_KEY, email: CFG.iq.email, password: CFG.iq.password }) }));
  } catch (e) { throw fail(502, 'iaqua_auth', String(e.message || e)); }
  if (!L || !L.userPoolOAuth || !L.userPoolOAuth.IdToken) throw fail(502, 'iaqua_auth');
  SD.iq.idt = L.userPoolOAuth.IdToken;
  SD.iq.exp = Date.now() + Number(L.userPoolOAuth.ExpiresIn || 3600) * 1000;
  return SD.iq.idt;
}
async function iqShadow(sn, desired, retry) {
  const idt = await iqLogin(false);
  const opts = { method: desired ? 'POST' : 'GET', url: 'https://prod.zodiac-io.com/devices/v1/' + sn + '/shadow', json: false, timeout: 20000,
    headers: { Authorization: idt, 'User-Agent': IQ_UA } };
  if (desired) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify({ state: { desired } }); }
  try { return parse(await helpers.httpRequest(opts)); }
  catch (e) {
    const st = String(e.httpCode || (e.response && e.response.status) || '');
    if (!retry && (st === '401' || st === '403')) { await iqLogin(true); return iqShadow(sn, desired, true); }
    throw fail(502, 'iaqua', String(e.message || e));
  }
}
function iqExo(rep) {
  const s = ((rep.equipment || {}).swc_0) || {}, sens = {};
  ['sns_1', 'sns_2', 'sns_3'].forEach((k) => { if (s[k]) sens[String(s[k].sensor_type || '').toLowerCase()] = s[k]; });
  const sched = [];
  Object.keys(rep.schedules || {}).forEach((k) => {
    const x = rep.schedules[k];
    if (x && typeof x === 'object' && x.timer) sched.push({ key: k, id: x.id, name: x.name, endpoint: x.endpoint, enabled: !!x.enabled, active: !!x.active, start: x.timer.start, end: x.timer.end, rpm: x.rpm || null });
  });
  sched.sort((a, b) => (a.start < b.start ? -1 : 1));
  return {
    online: (rep.aws || {}).status === 'connected', since: (rep.aws || {}).timestamp || null,
    production: s.production ?? null, state: s.exo_state ?? null, swc: s.swc ?? null, swcLow: s.swc_low ?? null,
    boost: s.boost ?? null, boostTime: s.boost_time || null, low: s.low ?? null,
    phSp: s.ph_sp != null ? s.ph_sp / 10 : null, orpSp: s.orp_sp ?? null,
    ph: sens.ph && sens.ph.state ? sens.ph.value / 10 : null, orp: sens.orp && sens.orp.state ? sens.orp.value : null,
    water: sens['water temp'] && sens['water temp'].state ? sens['water temp'].value : null,
    pump: s.filter_pump ? s.filter_pump.state : null, error: s.error_code || 0, schedules: sched,
    // Aux 1 : éclairage de la piscine (spots), branché sur l'électrolyseur
    aux1: s.aux_1 ? s.aux_1.state : null, aux1Type: s.aux_1 ? s.aux_1.type : null,
  };
}
function iqHp(rep) {
  const h = ((rep.equipment || {}).hp_0) || {};
  return {
    online: (rep.aws || {}).status === 'connected', since: (rep.aws || {}).timestamp || null,
    on: h.state === 1, setpoint: h.tsp ?? null, water: h.sns_1 ? h.sns_1.value : null, air: h.sns_2 ? h.sns_2.value : null,
    heating: h.hp === 1, status: h.status ?? null, reason: h.reason ?? null,
  };
}
async function iqState(fresh) {
  if (!fresh && SD.iqState && SD.iqState.at > Date.now() - 20000) return SD.iqState.data;
  const data = { ok: true, at: new Date().toISOString() };
  if (CFG.iq.exo) { const r = await iqShadow(CFG.iq.exo); data.exo = iqExo((r.state && r.state.reported) || {}); }
  if (CFG.iq.hpm) { try { const r = await iqShadow(CFG.iq.hpm); data.hp = iqHp((r.state && r.state.reported) || {}); } catch (e) { data.hp = null; } }
  SD.iqState = { at: Date.now(), data };
  return data;
}
async function iaqua(b) {
  if (!CFG.iq) throw fail(503, 'iaqua_not_configured');
  if (b.action === 'iq.state') return iqState(!!b.fresh && !(SD.iqState && SD.iqState.at > Date.now() - 5000));
  // Programmes (timers) de l'eXO : filtration 1-4 (sch5-8, avec vitesse), électrolyseur 1-2 (sch1-2), aux 1-2 (sch9-10)
  if (b.action === 'iq.sched') {
    const allowed = ['sch1', 'sch2', 'sch5', 'sch6', 'sch7', 'sch8', 'sch9', 'sch10'];
    const hm = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
    if (!CFG.iq.exo || !allowed.includes(b.sch) || !hm.test(String(b.start)) || !hm.test(String(b.end))) throw fail(403, 'not_allowed');
    const s = { timer: { start: b.start, end: b.end }, enabled: b.start === b.end ? 0 : 1 };
    if (['sch5', 'sch6', 'sch7', 'sch8'].includes(b.sch) && b.rpm != null) {
      const r = Number(b.rpm);
      if (!(r >= 600 && r <= 3450)) throw fail(403, 'not_allowed');
      s.rpm = Math.round(r / 50) * 50;
    }
    const desired = { schedules: {} }; desired.schedules[b.sch] = s;
    await iqShadow(CFG.iq.exo, desired);
    SD.iqState = null;
    return { ok: true, sch: b.sch, enabled: s.enabled };
  }
  if (b.action === 'iq.set') {
    // Liste blanche des réglages autorisés, avec bornes
    const v = Number(b.value);
    let sn, desired;
    if (b.dev === 'exo' && CFG.iq.exo) {
      sn = CFG.iq.exo;
      if (b.key === 'boost' && (v === 0 || v === 1)) desired = { equipment: { swc_0: { boost: v } } };
      else if (b.key === 'swc' && v >= 0 && v <= 100 && v % 5 === 0) desired = { equipment: { swc_0: { swc: v } } };
      else if (b.key === 'ph_sp' && v >= 6.8 && v <= 7.6) desired = { equipment: { swc_0: { ph_sp: Math.round(v * 10) } } };
      else if (b.key === 'pump' && (v === 0 || v === 1)) desired = { equipment: { swc_0: { filter_pump: { state: v } } } };
      else if (b.key === 'aux1' && (v === 0 || v === 1)) desired = { equipment: { swc_0: { aux_1: { state: v } } } };
    } else if (b.dev === 'hp' && CFG.iq.hpm) {
      sn = CFG.iq.hpm;
      if (b.key === 'on' && (v === 0 || v === 1)) desired = { equipment: { hp_0: { state: v } } };
      else if (b.key === 'tsp' && v >= 15 && v <= 32 && (v * 2) % 1 === 0) desired = { equipment: { hp_0: { tsp: v } } };
    }
    if (!desired) throw fail(403, 'not_allowed');
    await iqShadow(sn, desired);
    SD.iqState = null;
    return { ok: true, dev: b.dev, key: b.key, value: v };
  }
  throw fail(400, 'unknown_action');
}

async function tuya(b) {
  if (!CFG.tu) throw fail(503, 'tuya_not_configured');
  // Reconstitution de l'historique à partir du journal Tuya (7 derniers jours au maximum)
  // Compteurs : relevés de l'index (forward_energy_total). Sauna : petites quantités consommées (add_ele) additionnées.
  if (b.action === 'tu.backfill') {
    const id = CFG.tu.devices[b.key];
    if (!id) throw fail(403, 'not_allowed');
    const sc = await tuScales(id);
    const code = b.key === 'sauna' ? 'add_ele' : 'forward_energy_total';
    const end = Date.now(), start = end - 7 * 86400000;
    const logs = [];
    let rowKey = null;
    for (let page = 0; page < 60; page++) {
      const q = { codes: code, end_time: String(end), size: '100', start_time: String(start) };
      if (rowKey) q.last_row_key = rowKey;
      const path = '/v2.0/cloud/thing/' + id + '/report-logs?' + Object.keys(q).sort().map((k) => k + '=' + q[k]).join('&');
      const r = await tu('GET', path);
      (r.logs || []).forEach((x) => logs.push([Number(x.event_time), Number(x.value)]));
      if (!r.has_more || !r.last_row_key) break;
      rowKey = r.last_row_key;
    }
    logs.sort((x, y) => x[0] - y[0]);
    const div = Math.pow(10, sc[code] || 0);
    SD.en = SD.en || {};
    const e = SD.en[b.key] = SD.en[b.key] || { h: {}, d: {}, acc: 0, t: 0, p: null, last: null };
    const hKeys = Object.keys(e.h).sort(), firstKey = hKeys[0] || enKey(Date.now());
    // série d'index (kWh) dans le temps
    let series = [];
    if (code === 'forward_energy_total') series = logs.map((x) => [x[0], x[1] / div]);
    else {
      // sauna : on remonte le temps à partir de l'index du premier relevé déjà enregistré
      const anchor = hKeys.length ? e.h[firstKey] : (e.last || 0);
      const before = logs.filter((x) => enKey(x[0]) < firstKey);
      let cum = anchor - before.reduce((s, x) => s + x[1] / div, 0);
      series = before.map((x) => { cum += x[1] / div; return [x[0], Math.round(cum * 10000) / 10000]; });
      series.unshift([start, anchor - before.reduce((s, x) => s + x[1] / div, 0)]);
    }
    let addedH = 0, addedD = 0;
    series.forEach(([t, idx]) => {
      const hk = enKey(t), dk = hk.slice(0, 8);
      if (hk >= firstKey) return; // on ne touche pas à l'historique déjà enregistré
      if (e.h[hk] === undefined || idx < e.h[hk]) { if (e.h[hk] === undefined) addedH++; e.h[hk] = idx; }
      if (e.d[dk] === undefined || idx < e.d[dk]) { if (e.d[dk] === undefined) addedD++; e.d[dk] = idx; }
    });
    // le jour le plus récent reconstitué doit aussi couvrir le début du jour déjà enregistré
    const todayK = firstKey.slice(0, 8);
    const sameDay = series.filter(([t]) => enKey(t).slice(0, 8) === todayK && enKey(t) < firstKey);
    if (sameDay.length && sameDay[0][1] < (e.d[todayK] ?? Infinity)) e.d[todayK] = sameDay[0][1];
    return { ok: true, key: b.key, logs: logs.length, addedHours: addedH, addedDays: addedD, from: logs.length ? new Date(logs[0][0]).toISOString() : null };
  }
  if (b.action === 'tu.energy') {
    if (!CFG.tu.devices[b.key]) throw fail(403, 'not_allowed');
    const st = await tuState(!(SD.tuState && SD.tuState.at > Date.now() - 5000));
    return Object.assign({ ok: true, key: b.key, now: st.devices[b.key] || null }, enSeries(b.key));
  }
  // fresh : lecture directe chez Tuya (retour dans l'appli, ouverture d'une pièce), au plus une fois toutes les 5 s
  if (b.action === 'tu.state') return tuState(!!b.fresh && !(SD.tuState && SD.tuState.at > Date.now() - 5000));
  if (b.action === 'tu.switch') {
    if (!CFG.tu.switchable.includes(b.key) || typeof b.on !== 'boolean') throw fail(403, 'not_allowed');
    const id = CFG.tu.devices[b.key];
    await tu('POST', '/v1.0/iot-03/devices/' + id + '/commands', JSON.stringify({ commands: [{ code: 'switch', value: b.on }] }));
    SD.tuState = null;
    return { ok: true, key: b.key, on: b.on };
  }
  throw fail(400, 'unknown_action');
}

async function netatmo(b) {
  if (b.action === 'nt.heating') return ntHeating(false);
  if (b.action === 'nt.cameras') return ntCameras(!!b.fresh);
  if (b.action === 'nt.setpoint') {
    const H = await ntHomes();
    const room = H.heat && H.heat.rooms.find((r) => String(r.id) === String(b.room));
    if (!room) throw fail(403, 'not_allowed');
    if (b.mode === 'home') {
      await nt('POST', 'setroomthermpoint', { home_id: H.heat.id, room_id: room.id, mode: 'home' });
    } else {
      const t = Math.round(Number(b.temp) * 2) / 2;
      if (!(t >= 7 && t <= 30)) throw fail(403, 'not_allowed');
      const p = { home_id: H.heat.id, room_id: room.id, mode: 'manual', temp: t };
      const hours = Number(b.hours); if (hours > 0 && hours <= 12) p.endtime = Math.round(Date.now() / 1000 + hours * 3600);
      await nt('POST', 'setroomthermpoint', p);
    }
    return ntHeating(true);
  }
  // Graphique détaillé d'une pièce : température, consigne et % de chauffe, sur 6 h / 1 j / 1 sem / 1 mois / 1 an
  if (b.action === 'nt.roomgraph') {
    const H = await ntHomes();
    const room = H.heat && H.heat.rooms.find((r) => String(r.id) === String(b.room));
    const R = { '6h': [6 * 3600, '30min'], '1d': [86400, '30min'], '1w': [7 * 86400, '3hours'], '1m': [30 * 86400, '1day'], '1y': [365 * 86400, '1week'] }[b.range];
    if (!room || !R) throw fail(403, 'not_allowed');
    const end = Math.min(Math.floor(Date.now() / 1000), Number(b.end) || Math.floor(Date.now() / 1000));
    const begin = end - R[0];
    SD.ntGraph = SD.ntGraph || {};
    const key = room.id + '|' + b.range + '|' + Math.floor(end / 600), c = SD.ntGraph[key];
    if (c && c.at > Date.now() - 300000) return c.data;
    const read = async (types) => {
      const r = await nt('GET', 'getroommeasure', { home_id: H.heat.id, room_id: room.id, scale: R[1], type: types, date_begin: begin, date_end: end, optimize: 'false', real_time: 'true' });
      const rows = [], bd = r.body;
      if (Array.isArray(bd)) bd.forEach((blk) => (blk.value || []).forEach((v, i) => rows.push([blk.beg_time + i * (blk.step_time || 1800)].concat(v))));
      else if (bd && typeof bd === 'object') Object.keys(bd).forEach((ts) => rows.push([Number(ts)].concat(bd[ts])));
      return rows.sort((x, y) => x[0] - y[0]);
    };
    let rows, types = ['temperature', 'sp_temperature', 'heating_power_request'];
    try { rows = await read(types.join(',')); }
    catch (e) { types = ['temperature']; rows = await read('temperature'); }
    // Pièce du thermostat : % de chauffe = temps de marche de la chaudière (sum_boiler_on, en secondes par intervalle)
    const th = (H.heat.therm || []).find((t) => String(t.room) === String(room.id));
    let heatSrc = 'room';
    if (th && th.bridge) {
      try {
        const g = await nt('GET', 'getmeasure', { device_id: th.bridge, module_id: th.id, scale: R[1], type: 'sum_boiler_on', date_begin: begin, date_end: end, optimize: 'false', real_time: 'true' });
        const step = { '30min': 1800, '3hours': 10800, '1day': 86400, '1week': 604800 }[R[1]] || 1800;
        const on = {}; const bd = g.body;
        if (Array.isArray(bd)) bd.forEach((blk) => (blk.value || []).forEach((v, i) => { on[blk.beg_time + i * (blk.step_time || step)] = v[0]; }));
        else if (bd && typeof bd === 'object') Object.keys(bd).forEach((ts) => { on[Number(ts)] = bd[ts][0]; });
        const keys = Object.keys(on).map(Number);
        if (keys.length) {
          heatSrc = 'boiler';
          rows.forEach((r) => {
            // valeur la plus proche dans le temps (les horodatages des deux mesures ne tombent pas exactement pareil)
            let best = null, bd2 = Infinity; keys.forEach((k) => { const d = Math.abs(k - r[0]); if (d < bd2) { bd2 = d; best = k; } });
            r[3] = best != null && bd2 <= step ? Math.min(100, Math.round((on[best] || 0) / step * 100)) : null;
          });
        }
      } catch (e) { /* mesure chaudière indisponible */ }
    }
    const data = { ok: true, room: room.id, range: b.range, begin, end, types, heatSrc, rows };
    SD.ntGraph[key] = { at: Date.now(), data };
    Object.keys(SD.ntGraph).forEach((k) => { if (SD.ntGraph[k].at < Date.now() - 1800000) delete SD.ntGraph[k]; });
    return data;
  }
  // Historique de température d'une pièce Netatmo (pour les courbes), mis en cache 10 min
  if (b.action === 'nt.roomhist') {
    const H = await ntHomes();
    const room = H.heat && H.heat.rooms.find((r) => String(r.id) === String(b.room));
    if (!room) throw fail(403, 'not_allowed');
    const hours = Math.max(1, Math.min(168, Number(b.hours) || 24));
    SD.ntHist = SD.ntHist || {};
    const key = room.id + '|' + hours, c = SD.ntHist[key];
    if (c && c.at > Date.now() - 600000) return c.data;
    const end = Math.floor(Date.now() / 1000), begin = end - hours * 3600;
    const r = await nt('GET', 'getroommeasure', { home_id: H.heat.id, room_id: room.id, scale: hours > 48 ? '1hour' : '30min', type: 'temperature', date_begin: begin, date_end: end, optimize: 'false', real_time: 'true' });
    const pts = [];
    const bd = r.body;
    if (Array.isArray(bd)) bd.forEach((blk) => (blk.value || []).forEach((v, i) => pts.push([blk.beg_time + i * (blk.step_time || 1800), v[0]])));
    else if (bd && typeof bd === 'object') Object.keys(bd).forEach((ts) => pts.push([Number(ts), bd[ts][0]]));
    pts.sort((a, b2) => a[0] - b2[0]);
    const data = { ok: true, room: room.id, points: pts.filter((p) => p[1] != null) };
    SD.ntHist[key] = { at: Date.now(), data };
    return data;
  }
  // Plannings complets (ambiances avec température par pièce, plages de la semaine)
  if (b.action === 'nt.schedules') {
    if (b.fresh) SD.ntHomes = null;
    const H = await ntHomes();
    if (!H.heat) throw fail(404, 'no_heating');
    return { ok: true, rooms: H.heat.rooms, schedules: H.heat.schedules };
  }
  // Modifier un planning existant (nom, ambiances, plages)
  if (b.action === 'nt.syncschedule') {
    SD.ntHomes = null;
    const H = await ntHomes();
    const cur = H.heat && H.heat.schedules.find((x) => String(x.id) === String(b.id));
    if (!cur) throw fail(403, 'not_allowed');
    const err = ntCheckSchedule(H, b.schedule);
    if (err) throw fail(400, 'invalid', err);
    const body = ntScheduleBody(H, b.schedule); body.schedule_id = cur.id;
    const r = await ntJson('synchomeschedule', body);
    if (r && r.status && r.status !== 'ok') throw fail(502, 'netatmo', JSON.stringify(r));
    SD.ntHomes = null; SD.ntHeat = null;
    return { ok: true, id: cur.id };
  }
  // Créer un nouveau planning (à partir d'une copie préparée par l'appli)
  if (b.action === 'nt.createschedule') {
    SD.ntHomes = null;
    const H = await ntHomes();
    if (H.heat.schedules.length >= 10) throw fail(400, 'invalid', 'nombre maximum de plannings atteint');
    const err = ntCheckSchedule(H, b.schedule);
    if (err) throw fail(400, 'invalid', err);
    const r = await ntJson('createnewhomeschedule', ntScheduleBody(H, b.schedule));
    SD.ntHomes = null;
    return { ok: true, id: (r.body && r.body.schedule_id) || null };
  }
  if (b.action === 'nt.schedule') {
    const H = await ntHomes();
    const s = H.heat && H.heat.schedules.find((x) => String(x.id) === String(b.id));
    if (!s) throw fail(403, 'not_allowed');
    await nt('POST', 'switchhomeschedule', { home_id: H.heat.id, schedule_id: s.id });
    SD.ntHomes = null; // le planning « sélectionné » a changé
    return ntHeating(true);
  }
  if (b.action === 'nt.mode') {
    if (!['schedule', 'away', 'hg'].includes(b.mode)) throw fail(403, 'not_allowed');
    const H = await ntHomes();
    await nt('POST', 'setthermmode', { home_id: H.heat.id, mode: b.mode });
    return ntHeating(true);
  }
  throw fail(400, 'unknown_action');
}

try {
  if (isCron) {
    await enSample();
    // Porte de garage : photo de la caméra si c'est le moment (toutes les 5 min, ou juste après une commande / une confirmation)
    try { await garageAlert(); } catch (e) {}
    let gu = null; try { gu = await garageCamDue(); } catch (e) {}
    return gu ? [{ json: { garageUrl: gu } }] : []; // aucune réponse HTTP à envoyer
  }
  if (body.action === 'ping') return reply(200, { ok: true });
  // ---- Notifications ----
  if (String(body.action || '').startsWith('push.')) {
    if (!CFG.push) return reply(503, { ok: false, error: 'push_not_configured' });
    SD.push = SD.push || { subs: {}, delay: 2 };
    const ep = String(body.endpoint || ''), k = ep ? pushKey(ep) : null;
    if (ep && !/^https:[/][/][a-z0-9.-]+[/]/i.test(ep)) return reply(400, { ok: false, error: 'bad_endpoint' });
    if (body.action === 'push.pending') {
      const s = k && SD.push.subs[k];
      if (!s) return reply(404, { ok: false, error: 'unknown' });
      const items = s.q || []; s.q = [];
      return reply(200, { ok: true, items });
    }
    if (body.action === 'push.sub' && k) SD.push.subs[k] = Object.assign(SD.push.subs[k] || {}, { endpoint: ep, name: String(body.name || '').slice(0, 30), at: Date.now() });
    if (body.action === 'push.unsub' && k) delete SD.push.subs[k];
    if (body.action === 'push.cfg') { const d = Number(body.delay); if ([1, 2, 3, 5, 10, 15, 20, 30, 45, 60].includes(d)) SD.push.delay = d; }
    if (body.action === 'push.test') { const n = k && SD.push.subs[k] ? await pushNotify({ tag: 'test', title: 'Maison', body: 'Les notifications fonctionnent sur cet iPhone 👍', badge: null }, k) : 0; if (!n) return reply(200, { ok: false, error: (k && SD.push.subs[k] && SD.push.subs[k].lastErr) || 'not_subscribed' }); }
    return reply(200, { ok: true, on: !!(k && SD.push.subs[k]), delay: SD.push.delay || 2, count: Object.keys(SD.push.subs).length });
  }

  // Historique d'un capteur eedomus (liste blanche « readable »), mis en cache 10 min
  if (body.action === 'hist') {
    const id = String(body.id);
    if (!CFG.readable.includes(id)) return reply(403, { ok: false, error: 'not_allowed' });
    const hours = Math.max(1, Math.min(24 * 31, Number(body.hours) || 24));
    SD.hist = SD.hist || {};
    const key = id + '|' + hours, c = SD.hist[key];
    if (c && c.at > Date.now() - 600000) return reply(200, c.data);
    const fmtD = (d) => { const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach((x) => { p[x.type] = x.value; }); return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second; };
    const r = await eedomus('get', 'action=periph.history&periph_id=' + encodeURIComponent(id) + '&start_date=' + encodeURIComponent(fmtD(new Date(Date.now() - hours * 3600000))) + '&end_date=' + encodeURIComponent(fmtD(new Date())));
    if (r.success !== 1) return reply(502, { ok: false, error: 'eedomus', detail: r.body });
    const list = (r.body && (r.body.history || r.body)) || [];
    // eedomus renvoie [valeur ou texte, date] : on garde la valeur numérique (courbes) ET le texte (journaux)
    const points = (Array.isArray(list) ? list : []).map((x) => {
      const raw = Array.isArray(x) ? x[0] : (x.value != null ? x.value : x[0]), date = Array.isArray(x) ? x[1] : (x.date || x[1]);
      const n = Number(raw);
      return [date, isNaN(n) ? null : n, String(raw)];
    }).filter((p) => p[0]).sort((a, b2) => (a[0] < b2[0] ? -1 : 1));
    const data = { ok: true, id, points };
    SD.hist[key] = { at: Date.now(), data };
    Object.keys(SD.hist).forEach((k) => { if (SD.hist[k].at < Date.now() - 3600000) delete SD.hist[k]; });
    return reply(200, data);
  }
  if (body.action === 'state') {
    const r = await eedomus('get', 'action=periph.caract&periph_id=' + CFG.readable.join(','));
    if (r.success !== 1) return reply(502, { ok: false, error: 'eedomus', detail: r.body });
    const states = {};
    for (const p of r.body) {
      states[p.periph_id] = { value: p.last_value, text: p.last_value_text, unit: (p.unit || '').trim(), changed: p.last_value_change };
    }
    // mémorisé pour les journaux : ils ne relisent que les modules qui ont changé
    SD.lastChange = {}; Object.keys(states).forEach((k) => { SD.lastChange[String(k)] = states[k].changed; }); SD.lastChangeAt = Date.now();
    return reply(200, { ok: true, states, at: new Date().toISOString() });
  }

  if (body.action === 'set') {
    const id = String(body.id), value = String(body.value);
    const allowed = CFG.settable[id];
    if (!allowed || !allowed.includes(value)) return reply(403, { ok: false, error: 'not_allowed' });
    const r = await eedomus('set', 'action=periph.value&periph_id=' + encodeURIComponent(id) + '&value=' + encodeURIComponent(value));
    if (r.success !== 1) return reply(502, { ok: false, error: 'eedomus', detail: r.body });
    // Porte de garage : on retient l'état d'après la commande envoyée depuis l'appli
    if (id === String(CFG.logs.garage) && (value === '1' || value === '2')) { garageSet('unknown', 'commande'); garageCheckSoon(); }
    return reply(200, { ok: true, id, value });
  }

  // Journaux des 3 derniers jours : présence, alarme, portes (+ état de la porte de garage)
  if (body.action === 'logs') {
    const kind = String(body.kind || '');
    const list = CFG.logs[kind];
    if (!Array.isArray(list)) return reply(403, { ok: false, error: 'not_allowed' });
    SD.logs = SD.logs || {};
    SD.logHist = SD.logHist || {};
    const c = SD.logs[kind];
    let events;
    if (c && c.at > Date.now() - 15000) events = c.events;
    else {
      let failed = 0, calls = 0;
      const fmtD = (d) => { const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach((x) => { p[x.type] = x.value; }); return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second; };
      const pause = async () => { if (calls++) await new Promise((ok) => setTimeout(ok, 550)); }; // eedomus impose 0,5 s entre deux requêtes
      const ask = async (q) => { let r = null; for (let k = 0; k < 3 && !(r && r.success === 1); k++) { if (k) await new Promise((ok) => setTimeout(ok, 1500 * k)); try { r = await eedomus('get', q); } catch (e) { r = null; } } return r && r.success === 1 ? r : null; };
      // 1) Une seule question à eedomus : date du dernier changement de chaque module (ou celle que l'appli vient de lire)
      let lc = SD.lastChange && SD.lastChangeAt > Date.now() - 20000 ? SD.lastChange : null;
      if (!lc) { await pause(); const r0 = await ask('action=periph.caract&periph_id=' + list.map((x) => x.id).join(',')); if (r0) { lc = {}; [].concat(r0.body).forEach((p) => { lc[String(p.periph_id)] = p.last_value_change; }); } }
      const now = Date.now(), from72 = fmtD(new Date(now - 72 * 3600000));
      // 2) On ne relit que les modules qui ont changé, et seulement la partie récente (le reste est déjà en mémoire)
      for (const it of list) {
        const id = String(it.id), old = SD.logHist[id], fresh = old && old.at > now - 6 * 3600000;
        if (fresh && lc && lc[id] && lc[id] <= old.upTo) continue; // rien de nouveau depuis la dernière lecture
        const from = fresh ? fmtD(new Date(old.at - 120000)) : from72;
        await pause();
        const r = await ask('action=periph.history&periph_id=' + id + '&start_date=' + encodeURIComponent(from) + '&end_date=' + encodeURIComponent(fmtD(new Date())));
        if (!r) { failed++; continue; }
        const seen = {}, ev = [];
        ((r.body && r.body.history) || []).map((x) => [String(x[0]), x[1]]).concat(fresh ? old.ev : []).forEach((x) => { const k = x[1] + '|' + x[0]; if (!seen[k] && x[1] >= from72) { seen[k] = 1; ev.push(x); } });
        SD.logHist[id] = { at: now, upTo: fmtD(new Date(now)), ev };
      }
      events = [];
      list.forEach((it) => { const H = SD.logHist[String(it.id)]; (H ? H.ev : []).forEach((x) => { if (x[1] >= from72) events.push({ id: it.id, name: it.name, text: x[0], date: x[1] }); }); });
      events.sort((x, y) => (x.date < y.date ? 1 : -1));
      SD.logs[kind] = { at: Date.now(), events };
      SD.logsFail = SD.logsFail || {}; SD.logsFail[kind] = failed;
    }
    const out = { ok: true, kind, events, partial: !!(SD.logsFail && SD.logsFail[kind]) };
    if (kind === 'doors') out.garage = garageState(events);
    return reply(200, out);
  }
  // Correction manuelle de l'état de la porte de garage (après vérification sur la caméra)
  if (body.action === 'garage.mark') {
    if (body.state !== 'open' && body.state !== 'closed') return reply(403, { ok: false, error: 'not_allowed' });
    garageSet(body.state, 'manuel');
    // la prochaine photo deviendra une référence pour cet état (apprentissage jour / nuit)
    SD.garageCalib = { state: body.state, until: Date.now() + 5 * 60000 };
    SD.garageDues = [Date.now() + 5000];
    if (SD.logs) delete SD.logs.doors;
    return reply(200, { ok: true, garage: garageState([]) });
  }

  if (String(body.action || '').startsWith('nt.')) {
    if (!CFG.nt) return reply(503, { ok: false, error: 'netatmo_not_configured' });
    return reply(200, await netatmo(body));
  }
  if (String(body.action || '').startsWith('im.')) return reply(200, await imou(body));
  if (String(body.action || '').startsWith('tu.')) return reply(200, await tuya(body));
  if (String(body.action || '').startsWith('iq.')) return reply(200, await iaqua(body));

  return reply(400, { ok: false, error: 'unknown_action' });
} catch (e) {
  if (isCron) return [];
  if (e && e.httpStatus) return reply(e.httpStatus, { ok: false, error: e.code || 'error', detail: e.detail });
  return reply(500, { ok: false, error: 'exception', detail: String(e && e.message || e) });
}
`;

// Garde-fou : ne jamais déployer un code qui ne compile pas (sinon toute l'appli tombe).
try {
  new Function('$input', '$getWorkflowStaticData', 'Buffer', 'return (async function(){' + code + '\n});');
} catch (e) {
  console.error('ARRÊT : le code n8n ne compile pas ->', e.message);
  process.exit(1);
}

// Analyse de la photo du garage (nœud séparé, même mémoire que le workflow)
const garageCode = `
const G = $getWorkflowStaticData('global');
function localNow() {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}
let buf;
try { buf = await this.helpers.getBinaryDataBuffer(0, 'data'); } catch (e) { G.garageCam = Object.assign({}, G.garageCam || {}, { error: 'image' }); return []; }
// Lecture du BMP (24/32 bits ou 8 bits avec palette)
const off = buf.readUInt32LE(10), w = buf.readInt32LE(18), hh = buf.readInt32LE(22), bpp = buf.readUInt16LE(28), h = Math.abs(hh);
const rowSize = Math.floor((bpp * w + 31) / 32) * 4, palOff = 14 + buf.readUInt32LE(14);
const gray = [];
for (let y = 0; y < h; y++) {
  const row = hh < 0 ? y : h - 1 - y;
  for (let x = 0; x < w; x++) {
    let r, g, b;
    if (bpp >= 24) { const i = off + row * rowSize + x * (bpp / 8); b = buf[i]; g = buf[i + 1]; r = buf[i + 2]; }
    else { const k = buf[off + row * rowSize + x], pi = palOff + k * 4; b = buf[pi]; g = buf[pi + 1]; r = buf[pi + 2]; }
    gray.push(0.299 * r + 0.587 * g + 0.114 * b);
  }
}
// on ignore la zone de la date incrustée (en haut à droite), qui change à chaque photo
const keep = [];
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (!(y <= 2 && x >= Math.floor(w * 0.66))) keep.push(gray[y * w + x]); }
const mean = keep.reduce((s, v) => s + v, 0) / keep.length;
const sd = Math.sqrt(keep.reduce((s, v) => s + (v - mean) * (v - mean), 0) / keep.length) || 1;
const vec = keep.map((v) => Math.round((v - mean) / sd * 1000) / 1000);
const ncc = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s / a.length; };
G.garageRefs = G.garageRefs || [];
// Apprentissage : la photo qui suit une confirmation manuelle devient une référence (6 au maximum par état)
if (G.garageCalib && G.garageCalib.until > Date.now()) {
  G.garageRefs.push({ state: G.garageCalib.state, v: vec, at: Date.now(), bright: Math.round(mean) });
  const st = G.garageCalib.state, same = G.garageRefs.filter((r) => r.state === st);
  if (same.length > 6) G.garageRefs.splice(G.garageRefs.indexOf(same[0]), 1);
  G.garageCalib = null;
}
const best = { open: null, closed: null };
G.garageRefs.forEach((r) => { if (r.v.length !== vec.length) return; const c = ncc(vec, r.v); if (best[r.state] === null || c > best[r.state]) best[r.state] = c; });
let state = null, margin = null;
if (best.open !== null && best.closed !== null) {
  margin = Math.round((best.open - best.closed) * 1000) / 1000;
  if (margin > 0.08) state = 'open'; else if (margin < -0.08) state = 'closed';
}
G.garageCam = { at: Date.now(), tryAt: (G.garageCam && G.garageCam.tryAt) || Date.now(), state, margin, best, bright: Math.round(mean) };
// Porte encore en mouvement ou état pas sûr juste après une commande : nouvelle photo 30 s plus tard
if (!state && G.garage && G.garage.state === 'unknown' && (G.garageRetry || 0) > 0) { G.garageRetry--; G.garageDues = (G.garageDues || []).concat([Date.now() + 20000]); }
// État confirmé par la caméra : on met à jour l'état mémorisé s'il change (ou s'il était « à vérifier »)
if (state && (!G.garage || G.garage.state !== state)) {
  const prev = G.garage, fromCmd = prev && prev.state === 'unknown' && prev.src === 'commande' && prev.date;
  G.garage = { state, date: fromCmd || localNow(), src: 'camera' };
  G.garageLog = [{ state, date: G.garage.date, src: 'camera' }].concat(G.garageLog || []).slice(0, 40);
  if (G.logs) delete G.logs.doors;
}
return [];
`;
try { new Function('$getWorkflowStaticData', 'return (async function(){' + garageCode + '\n});'); }
catch (e) { console.error('ARRÊT : le code « Analyse garage » ne compile pas ->', e.message); process.exit(1); }

const NAME = 'Maison · API eedomus';
const PATH = 'maison';

const workflow = {
  name: NAME,
  nodes: [
    {
      parameters: {
        httpMethod: 'POST',
        path: PATH,
        responseMode: 'responseNode',
        options: { allowedOrigins: '*' },
      },
      id: randomUUID(),
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
      webhookId: '6d1f5c2e-6a0b-4c55-9d2a-3c8e5a1f0b01',
    },
    {
      // Minuterie : relevés d'énergie Smart Life toutes les 5 minutes (le code décide s'il faut vraiment interroger Tuya)
      parameters: { rule: { interval: [{ field: 'seconds', secondsInterval: 30 }] } },
      id: randomUUID(),
      name: 'Relevés énergie',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 220],
    },
    {
      parameters: { jsCode: code },
      id: randomUUID(),
      name: 'eedomus',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [260, 0],
    },
    {
      parameters: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify($json.data) }}',
        options: {
          responseCode: '={{ $json.status }}',
          responseHeaders: { entries: [{ name: 'Access-Control-Allow-Origin', value: '*' }] },
        },
      },
      id: randomUUID(),
      name: 'Réponse',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [760, -120],
    },
    // --- Porte de garage vue par la caméra : photo → image réduite (32×24) → comparaison aux références ---
    {
      parameters: { conditions: { string: [{ value1: '={{ $json.garageUrl || "" }}', operation: 'isNotEmpty' }] } },
      id: randomUUID(), name: 'Photo garage ?', type: 'n8n-nodes-base.if', typeVersion: 1, position: [500, 0],
    },
    {
      parameters: { url: '={{ $json.garageUrl }}', options: { response: { response: { responseFormat: 'file' } } } },
      id: randomUUID(), name: 'Photo garage', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [760, 120],
    },
    {
      parameters: { operation: 'resize', width: 32, height: 24, resizeOption: 'ignoreAspectRatio', options: { format: 'bmp' } },
      id: randomUUID(), name: 'Réduire', type: 'n8n-nodes-base.editImage', typeVersion: 1, position: [980, 120],
    },
    {
      parameters: { jsCode: garageCode },
      id: randomUUID(), name: 'Analyse garage', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1200, 120],
    },
  ],
  connections: {
    Webhook: { main: [[{ node: 'eedomus', type: 'main', index: 0 }]] },
    'Relevés énergie': { main: [[{ node: 'eedomus', type: 'main', index: 0 }]] },
    eedomus: { main: [[{ node: 'Photo garage ?', type: 'main', index: 0 }]] },
    'Photo garage ?': { main: [[{ node: 'Photo garage', type: 'main', index: 0 }], [{ node: 'Réponse', type: 'main', index: 0 }]] },
    'Photo garage': { main: [[{ node: 'Réduire', type: 'main', index: 0 }]] },
    'Réduire': { main: [[{ node: 'Analyse garage', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none' },
};

const base = env.N8N_URL.replace(/\/+$/, '');
const headers = { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' };

async function api(method, path, body) {
  const res = await fetch(base + '/api/v1' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function findByName(name) {
  let cursor;
  do {
    const r = await api('GET', '/workflows?limit=100' + (cursor ? '&cursor=' + cursor : ''));
    const hit = r.data.find((w) => w.name === name);
    if (hit) return hit;
    cursor = r.nextCursor;
  } while (cursor);
  return null;
}

const existing = await findByName(NAME);
let wf;
if (existing) {
  // Conserver la mémoire du workflow (jeton Netatmo qui tourne) d'un déploiement à l'autre.
  const full = await api('GET', `/workflows/${existing.id}`);
  if (full.staticData) workflow.staticData = full.staticData;
  if (existing.active) await api('POST', `/workflows/${existing.id}/deactivate`);
  try {
    wf = await api('PUT', `/workflows/${existing.id}`, workflow);
  } catch (e) {
    if (!/staticData/.test(e.message)) throw e;
    delete workflow.staticData;
    wf = await api('PUT', `/workflows/${existing.id}`, workflow);
    console.log('Attention : la mémoire du workflow n\'a pas pu être conservée.');
  }
  console.log('Workflow mis à jour :', wf.id);
} else {
  wf = await api('POST', '/workflows', workflow);
  console.log('Workflow créé :', wf.id);
}
await api('POST', `/workflows/${wf.id}/activate`);
console.log('Workflow activé. URL :', `${base}/webhook/${PATH}`);
writeFileSync(join(root, 'private', 'n8n-workflow-id.txt'), wf.id);
