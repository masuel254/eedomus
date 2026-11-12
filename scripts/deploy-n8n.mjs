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
      default: throw new Error(`Type inconnu: ${it.type}`);
    }
  }
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
  nt: env.NETATMO_REFRESH_TOKEN ? {
    id: env.NETATMO_CLIENT_ID,
    secret: env.NETATMO_CLIENT_SECRET,
    refresh: env.NETATMO_REFRESH_TOKEN,
    // L'empreinte change seulement si on refait l'autorisation : n8n garde sinon son propre jeton (Netatmo le fait tourner).
    seed: createHash('sha256').update(env.NETATMO_REFRESH_TOKEN.split('|')[0]).digest('hex').slice(0, 16),
  } : null,
  deployedAt: Date.now(),
  iq: env.IAQUA_EMAIL ? { email: env.IAQUA_EMAIL, password: env.IAQUA_PASSWORD, exo: env.IAQUA_EXO_SN || null, hpm: env.IAQUA_HPM_SN || null } : null,
  im: env.IMOU_APP_ID ? { id: env.IMOU_APP_ID, secret: env.IMOU_APP_SECRET } : null,
  tu: env.TUYA_CLIENT_ID ? {
    id: env.TUYA_CLIENT_ID, secret: env.TUYA_CLIENT_SECRET, base: 'https://openapi.tuyaeu.com',
    devices: { sauna: env.TUYA_DEV_SAUNA, pac: env.TUYA_DEV_PAC, elec: env.TUYA_DEV_ELEC },
    switchable: ['sauna'],
  } : null,
};

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
if (!isCron && (!body.token || !CFG.tokens.includes(body.token))) return reply(401, { ok: false, error: 'unauthorized' });

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

// ---------------- Netatmo ----------------
const SD = $getWorkflowStaticData('global');
// Nouveau déploiement : on vide les données en cache (formats changés), on garde les jetons d'accès.
if (SD.deployedAt !== CFG.deployedAt) {
  ['ntHomes', 'ntHeat', 'ntCams', 'imDev', 'imLive', 'imSnap', 'imRec', 'tuState', 'tuSpec', 'iqState'].forEach((k) => { delete SD[k]; });
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
      schedules: (heat.schedules || []).filter((s) => !s.type || s.type === 'therm').map((s) => ({
        id: s.id, name: s.name, selected: !!s.selected,
        timetable: (s.timetable || []).map((t) => ({ z: t.zone_id, o: t.m_offset })).sort((a, b) => a.o - b.o),
        zones: (s.zones || []).map((z) => ({ id: z.id, name: z.name || null, type: z.type })),
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
  const sel = H.heat.schedules.find((s) => s.selected) || null;
  const data = {
    ok: true, home: H.heat.id,
    schedule: sel ? sel.name : null,
    scheduleId: sel ? sel.id : null,
    schedules: H.heat.schedules.map((s) => ({ id: s.id, name: s.name })),
    slot: sel ? ntSlot(sel, H.heat.tz) : null,
    rooms: H.heat.rooms.map((r) => {
      const s = byId[r.id] || {};
      return { id: r.id, name: r.name, temp: s.therm_measured_temperature ?? null, setpoint: s.therm_setpoint_temperature ?? null,
        mode: s.therm_setpoint_mode || null, end: s.therm_setpoint_end_time || null, heating: (s.heating_power_request || 0) > 0, open_window: !!s.open_window };
    }),
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
  if (isCron) { await enSample(); return []; } // aucune réponse HTTP à envoyer
  if (body.action === 'ping') return reply(200, { ok: true });

  if (body.action === 'state') {
    const r = await eedomus('get', 'action=periph.caract&periph_id=' + CFG.readable.join(','));
    if (r.success !== 1) return reply(502, { ok: false, error: 'eedomus', detail: r.body });
    const states = {};
    for (const p of r.body) {
      states[p.periph_id] = { value: p.last_value, text: p.last_value_text, unit: (p.unit || '').trim(), changed: p.last_value_change };
    }
    return reply(200, { ok: true, states, at: new Date().toISOString() });
  }

  if (body.action === 'set') {
    const id = String(body.id), value = String(body.value);
    const allowed = CFG.settable[id];
    if (!allowed || !allowed.includes(value)) return reply(403, { ok: false, error: 'not_allowed' });
    const r = await eedomus('set', 'action=periph.value&periph_id=' + encodeURIComponent(id) + '&value=' + encodeURIComponent(value));
    if (r.success !== 1) return reply(502, { ok: false, error: 'eedomus', detail: r.body });
    return reply(200, { ok: true, id, value });
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
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } },
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
      position: [520, 0],
    },
  ],
  connections: {
    Webhook: { main: [[{ node: 'eedomus', type: 'main', index: 0 }]] },
    'Relevés énergie': { main: [[{ node: 'eedomus', type: 'main', index: 0 }]] },
    eedomus: { main: [[{ node: 'Réponse', type: 'main', index: 0 }]] },
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
