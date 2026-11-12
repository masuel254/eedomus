// Lecture seule : obtient un accessToken Imou et liste les caméras visibles par l'application.
// Usage : node scripts/imou-explore.mjs
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));

let base = 'https://openapi.easy4ip.com/openapi';
async function call(method, params) {
  const time = Math.floor(Date.now() / 1000), nonce = randomUUID();
  const sign = createHash('md5').update(`time:${time},nonce:${nonce},appSecret:${env.IMOU_APP_SECRET}`).digest('hex');
  const r = await fetch(`${base}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: { ver: '1.0', appId: env.IMOU_APP_ID, sign, time, nonce }, id: randomUUID(), params }),
  });
  const j = await r.json();
  return j.result || j;
}

const t = await call('accessToken', {});
console.log('accessToken :', t.code, t.msg);
if (t.code !== '0') process.exit(1);
const token = t.data.accessToken;
if (t.data.currentDomain) { base = t.data.currentDomain.replace(/:443$/, '') + '/openapi'; console.log('Région :', t.data.currentDomain); }

for (const [method, params] of [
  ['deviceBaseList', { token, bindId: -1, limit: 128, type: 'bindAndShare', needApInfo: false }],
  ['listDeviceDetailsByPage', { token, page: 1, pageSize: 50 }],
]) {
  const r = await call(method, params);
  const list = r.data?.deviceList || r.data?.devices || [];
  console.log(`\n${method} : code=${r.code} ${r.msg} · ${list.length} appareil(s)`);
  for (const d of list) {
    const chans = d.channels || d.channelList || [];
    console.log(`  - ${d.deviceName || d.name || '?'} [${d.deviceId}] modèle=${d.deviceModel || d.productId || '-'} statut=${d.deviceStatus || d.status || '-'} canaux=${chans.map((c) => (c.channelName || c.channelId) + ':' + (c.channelStatus || c.status || '')).join(', ')}`);
  }
}
