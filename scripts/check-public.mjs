// Vérification avant chaque publication (git push) : aucun secret ni donnée personnelle dans les fichiers prêts à partir.
// Les valeurs à chercher viennent de .env ou des variables d'environnement : elles ne sont jamais écrites ici.
// PRIVATE_WORDS = expression régulière des mots interdits (prénoms, adresse, références client…).
// Usage : git add ... puis node scripts/check-public.mjs   (code de sortie 1 = STOP, ne pas publier)
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const env = { ...process.env };
if (existsSync(envPath)) for (const l of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2]; }
const SECRET = /^(MAISON_TOKEN|EEDOMUS_API|N8N_API_KEY|NETATMO_CLIENT_SECRET|NETATMO_REFRESH|IMOU_APP_SECRET|TUYA_CLIENT_SECRET|IAQUA_PASSWORD|IAQUA_EMAIL|VAPID_PRIVATE|QUANDIFY_|TOTAL_|EDF_|PEOPLE_NAMES)/;
const keys = Object.keys(env).filter((k) => SECRET.test(k) && env[k] && env[k].length > 3);
if (!env.PRIVATE_WORDS) { console.log('STOP : PRIVATE_WORDS absent (liste des mots personnels interdits)'); process.exit(1); }
if (!keys.length) { console.log('STOP : aucun secret trouvé pour comparer (.env ou variables absentes)'); process.exit(1); }
const priv = new RegExp(env.PRIVATE_WORDS, 'i');
const files = execSync('git diff --cached --name-only --diff-filter=ACMR', { cwd: root }).toString().trim().split(/\n/).filter(Boolean);
let bad = 0;
for (const f of files) {
  const t = readFileSync(join(root, f), 'utf8');
  // PEOPLE_NAMES : seulement les prénoms affichés (à droite du =), le nom eedomus peut être un mot courant
  for (const k of keys) for (const v of k === 'PEOPLE_NAMES' ? env[k].split(/[,;]/).map((x) => x.split('=').pop().trim()).filter((x) => x.length > 3) : [env[k]]) if (t.includes(v)) { console.log('SECRET', k, 'dans', f); bad = 1; }
  const m = t.match(priv); if (m) { console.log('DONNÉE PERSONNELLE dans', f, ':', m[0].slice(0, 2) + '…'); bad = 1; }
}
if (bad) { console.log('STOP : ne pas publier'); process.exit(1); }
console.log('propre (' + files.length + ' fichiers vérifiés)');
