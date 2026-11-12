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
