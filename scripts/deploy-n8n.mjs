// Crée ou met à jour le workflow n8n "Maison · API eedomus".
// Les secrets sont lus dans .env (jamais publié) et injectés uniquement dans n8n.
// Usage : node scripts/deploy-n8n.mjs
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
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
  token: env.MAISON_TOKEN,
  settable,
  readable: [...readable],
};

const code = `
const CFG = ${JSON.stringify(CODE_CFG)};
const helpers = this.helpers;
const req = $input.first().json;
let body = req.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
body = body || {};
const reply = (status, data) => [{ json: { status, data } }];
if (!body.token || body.token !== CFG.token) return reply(401, { ok: false, error: 'unauthorized' });

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

  return reply(400, { ok: false, error: 'unknown_action' });
} catch (e) {
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
  if (existing.active) await api('POST', `/workflows/${existing.id}/deactivate`);
  wf = await api('PUT', `/workflows/${existing.id}`, workflow);
  console.log('Workflow mis à jour :', wf.id);
} else {
  wf = await api('POST', '/workflows', workflow);
  console.log('Workflow créé :', wf.id);
}
await api('POST', `/workflows/${wf.id}/activate`);
console.log('Workflow activé. URL :', `${base}/webhook/${PATH}`);
writeFileSync(join(root, 'private', 'n8n-workflow-id.txt'), wf.id);
