// Lecture seule : connexion au cloud iAquaLink (Zodiac) et liste des appareils de la piscine.
// API non officielle, telle qu'utilisée par l'intégration Home Assistant (bibliothèque iaqualink-py).
// Usage : node scripts/iaqua-explore.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const API_KEY = 'EOOEMOW4YR6QNB07'; // clé publique de l'appli iAquaLink (identique pour tous les utilisateurs)
const UA = 'okhttp/3.14.7';

const login = await fetch('https://prod.zodiac-io.com/users/v1/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
  body: JSON.stringify({ api_key: API_KEY, email: env.IAQUA_EMAIL, password: env.IAQUA_PASSWORD }),
});
const L = await login.json().catch(() => ({}));
if (!login.ok || !L.authentication_token) { console.error('Connexion refusée :', login.status, JSON.stringify(L).slice(0, 200)); process.exit(1); }
console.log('Connexion OK · utilisateur', L.id, '· jeton IdToken :', !!(L.userPoolOAuth && L.userPoolOAuth.IdToken));

const qs = new URLSearchParams({ api_key: API_KEY, authentication_token: L.authentication_token, user_id: L.id });
const devs = await fetch('https://r-api.iaqualink.net/devices.json?' + qs, { headers: { 'User-Agent': UA } }).then((r) => r.json());
console.log('\nAppareils :', Array.isArray(devs) ? devs.length : JSON.stringify(devs).slice(0, 200));
for (const d of Array.isArray(devs) ? devs : []) {
  console.log(`\n=== ${d.name} · type=${d.device_type} · série=${d.serial_number} · modèle=${d.model || d.product_name || '-'}`);
  if (['exo', 'i2d', 'cyclobat', 'cyclonext', 'vr', 'vortrax'].includes(d.device_type)) {
    // Appareils récents : état « shadow » (AWS IoT)
    const sh = await fetch(`https://prod.zodiac-io.com/devices/v1/${d.serial_number}/shadow`, {
      headers: { Authorization: L.userPoolOAuth.IdToken, 'User-Agent': UA },
    });
    const S = await sh.json().catch(() => ({}));
    const rep = S.state && S.state.reported ? S.state.reported : S;
    console.log('shadow HTTP', sh.status);
    console.log(JSON.stringify(rep, null, 1).slice(0, 3500));
  } else if (d.device_type === 'iaqua') {
    const s = new URLSearchParams({ actionID: 'command', command: 'get_home', serial: d.serial_number, sessionID: L.session_id });
    const h = await fetch('https://p-api.iaqualink.net/v1/mobile/session.json?' + s, { headers: { 'User-Agent': UA } }).then((r) => r.json()).catch(() => ({}));
    console.log(JSON.stringify(h).slice(0, 2000));
  }
}
