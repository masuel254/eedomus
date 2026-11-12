// Lecture seule : état et fonctions des appareils Smart Life (Tuya cloud, Europe).
// Usage : node scripts/tuya-explore.mjs <deviceId> [<deviceId> ...]
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const BASE = 'https://openapi.tuyaeu.com';
const ID = env.TUYA_CLIENT_ID, SECRET = env.TUYA_CLIENT_SECRET;

async function req(method, path, token = '', body = '') {
  const t = String(Date.now()), nonce = randomUUID();
  const sts = [method, createHash('sha256').update(body).digest('hex'), '', path].join('\n');
  const sign = createHmac('sha256', SECRET).update(ID + token + t + nonce + sts).digest('hex').toUpperCase();
  const headers = { client_id: ID, sign, t, nonce, sign_method: 'HMAC-SHA256', 'Content-Type': 'application/json' };
  if (token) headers.access_token = token;
  const r = await fetch(BASE + path, { method, headers, body: body || undefined });
  return r.json();
}

const tk = await req('GET', '/v1.0/token?grant_type=1');
if (!tk.success) { console.error('Jeton refusé :', tk.code, tk.msg); process.exit(1); }
const token = tk.result.access_token;
console.log('Jeton OK (expire dans', tk.result.expire_time, 's)');

for (const id of process.argv.slice(2)) {
  const info = await req('GET', `/v1.0/devices/${id}`, token);
  const spec = await req('GET', `/v1.0/devices/${id}/specifications`, token);
  console.log(`\n=== ${info.result?.name} [${id}] en ligne=${info.result?.online} catégorie=${spec.result?.category}`);
  const scales = {};
  for (const s of [...(spec.result?.status || []), ...(spec.result?.functions || [])]) {
    try { const v = JSON.parse(s.values); if (v.scale !== undefined) scales[s.code] = { scale: v.scale, unit: v.unit }; } catch {}
  }
  for (const s of info.result?.status || []) {
    const sc = scales[s.code];
    const human = sc && typeof s.value === 'number' ? (s.value / 10 ** sc.scale) + ' ' + (sc.unit || '') : '';
    console.log(`  ${s.code.padEnd(22)} = ${JSON.stringify(s.value)}${human ? '  → ' + human : ''}`);
  }
  console.log('  commandes possibles :', (spec.result?.functions || []).map((f) => f.code).join(', ') || '(aucune)');
}
