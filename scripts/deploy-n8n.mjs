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
  im: env.IMOU_APP_ID ? { id: env.IMOU_APP_ID, secret: env.IMOU_APP_SECRET } : null,
};

const code = `
const CFG = ${JSON.stringify(CODE_CFG)};
const helpers = this.helpers;
const req = $input.first().json;
let body = req.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
body = body || {};
const reply = (status, data) => [{ json: { status, data } }];
if (!body.token || !CFG.tokens.includes(body.token)) return reply(401, { ok: false, error: 'unauthorized' });

const auth = 'api_user=' + encodeURIComponent(CFG.user) + '&api_secret=' + encodeURIComponent(CFG.secret);
async function eedomus(kind, query) {
  const raw = await helpers.httpRequest({
    url: 'https://api.eedomus.com/' + kind + '?' + auth + '&' + query,
    encoding: 'arraybuffer',
    json: false,
    timeout: 15000,
  });
  const text = Buffer.from(raw).toString('latin1');
  return JSON.parse(text);
}

// ---------------- Netatmo ----------------
const SD = $getWorkflowStaticData('global');
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
    heat: heat ? { id: heat.id, rooms: heat.rooms.filter((r) => (r.module_ids || []).length).map((r) => ({ id: r.id, name: r.name, type: r.type })),
      schedules: (heat.schedules || []).filter((s) => !s.type || s.type === 'therm').map((s) => ({ id: s.id, name: s.name, selected: !!s.selected })) } : null,
    cams,
  };
  return SD.ntHomes;
}
async function ntHeating(fresh) {
  if (!fresh && SD.ntHeat && SD.ntHeat.at > Date.now() - 20000) return SD.ntHeat.data;
  const H = await ntHomes();
  if (!H.heat) throw fail(404, 'no_heating');
  const st = await nt('GET', 'homestatus', { home_id: H.heat.id });
  const home = (st.body && st.body.home) || {};
  const byId = {}; (home.rooms || []).forEach((r) => { byId[r.id] = r; });
  const data = {
    ok: true, home: H.heat.id,
    schedule: (H.heat.schedules.find((s) => s.selected) || {}).name || null,
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
  const out = [], events = [];
  const homeIds = [...new Set(H.cams.map((c) => c.home))];
  for (const hid of homeIds) {
    const st = await nt('GET', 'homestatus', { home_id: hid });
    const mods = {}; ((st.body && st.body.home && st.body.home.modules) || []).forEach((m) => { mods[m.id] = m; });
    H.cams.filter((c) => c.home === hid).forEach((c) => {
      const m = mods[c.id] || {}, vpn = m.vpn_url || null;
      out.push({ id: c.id, name: c.name, type: c.type, on: m.monitoring === 'on', status: m.monitoring || m.status || null,
        light: m.floodlight || null, live: vpn ? vpn + '/live/files/high/index.m3u8' : null, liveLow: vpn ? vpn + '/live/files/low/index.m3u8' : null,
        snapshot: vpn ? vpn + '/live/snapshot_720.jpg' : null });
    });
    try {
      const ev = await nt('GET', 'getevents', { home_id: hid, size: 15 });
      ((ev.body && ev.body.home && ev.body.home.events) || []).forEach((e) => {
        const sub = (e.subevents || [])[0] || {};
        events.push({ id: e.id, camera: e.module_id, time: e.time, type: sub.type || e.type, message: e.message || null,
          snapshot: (sub.snapshot && sub.snapshot.url) || (e.snapshot && e.snapshot.url) || null });
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
  if (b.action === 'nt.mode') {
    if (!['schedule', 'away', 'hg'].includes(b.mode)) throw fail(403, 'not_allowed');
    const H = await ntHomes();
    await nt('POST', 'setthermmode', { home_id: H.heat.id, mode: b.mode });
    return ntHeating(true);
  }
  throw fail(400, 'unknown_action');
}

try {
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

  return reply(400, { ok: false, error: 'unknown_action' });
} catch (e) {
  if (e && e.httpStatus) return reply(e.httpStatus, { ok: false, error: e.code || 'error', detail: e.detail });
  return reply(500, { ok: false, error: 'exception', detail: String(e && e.message || e) });
}
`;

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
