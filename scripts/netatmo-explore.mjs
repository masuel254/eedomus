// Lecture seule : affiche la maison Netatmo (pièces, modules, chauffage, caméras).
// Renouvelle l'accès et enregistre le nouveau refresh_token dans .env (Netatmo le fait tourner).
// Usage : node scripts/netatmo-explore.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ATTENTION : une fois n8n déployé, c'est n8n qui détient le jeton Netatmo (il tourne à chaque renouvellement).
// Lancer ce script avec l'ancien jeton du .env peut casser l'accès de n8n. Utiliser --force seulement juste après netatmo-auth.mjs.
if (!process.argv.includes('--force')) { console.error('Bloqué : n8n gère le jeton Netatmo. Relancer avec --force seulement juste après netatmo-auth.mjs.'); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const env = Object.fromEntries(readFileSync(envPath, 'utf8').split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));

const tr = await fetch('https://api.netatmo.com/oauth2/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.NETATMO_REFRESH_TOKEN, client_id: env.NETATMO_CLIENT_ID, client_secret: env.NETATMO_CLIENT_SECRET }),
}).then((r) => r.json());
if (!tr.access_token) { console.error('Échec du renouvellement :', tr); process.exit(1); }
writeFileSync(envPath, readFileSync(envPath, 'utf8').replace(/^NETATMO_REFRESH_TOKEN=.*$/m, 'NETATMO_REFRESH_TOKEN=' + tr.refresh_token));

const get = (path, q = {}) => fetch('https://api.netatmo.com/api/' + path + '?' + new URLSearchParams(q), { headers: { Authorization: 'Bearer ' + tr.access_token } }).then((r) => r.json());

const hd = await get('homesdata');
for (const home of hd.body.homes) {
  console.log(`\n=== Maison "${home.name}" (${home.id}) · mode chauffage: ${home.therm_mode || '-'}`);
  const st = await get('homestatus', { home_id: home.id });
  const sRooms = Object.fromEntries((st.body?.home?.rooms || []).map((r) => [r.id, r]));
  const sMods = Object.fromEntries((st.body?.home?.modules || []).map((m) => [m.id, m]));
  console.log('Pièces :');
  for (const r of home.rooms || []) {
    const s = sRooms[r.id] || {};
    console.log(`  - ${r.name} [${r.id}] type=${r.type} · mesuré=${s.therm_measured_temperature ?? '-'}° consigne=${s.therm_setpoint_temperature ?? '-'}° mode=${s.therm_setpoint_mode ?? '-'} chauffe=${s.heating_power_request ?? '-'} modules=${(r.module_ids || []).length}`);
  }
  console.log('Modules :');
  for (const m of home.modules || []) {
    const s = sMods[m.id] || {};
    const extra = m.type === 'NOC' || m.type === 'NACamera' || m.type === 'NDB'
      ? ` · statut=${s.monitoring ?? s.status ?? '-'} sd=${s.sd_status ?? '-'} vpn=${s.vpn_url ? 'oui' : 'non'} local=${s.is_local ?? '-'}`
      : ` · batterie=${s.battery_state ?? '-'} joignable=${s.reachable ?? '-'}`;
    console.log(`  - ${m.type.padEnd(8)} ${m.name} [${m.id}] pièce=${m.room_id ?? '-'}${extra}`);
  }
  const sched = (home.schedules || []).filter((s) => s.type === 'therm' || !s.type);
  if (sched.length) console.log('Plannings chauffage : ' + sched.map((s) => s.name + (s.selected ? ' (actif)' : '')).join(', '));
  if (home.temperature_control_mode) console.log('Contrôle : ' + home.temperature_control_mode);
}
