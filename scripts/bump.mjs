// Nouvelle version de l'appli (date + heure de Paris) : changelog.json + cache du service worker.
// Usage : node scripts/bump.mjs <version> "<titre>" "<changement 1>" "<changement 2>" ...
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const d = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs') + '/';
const [version, title, ...changes] = process.argv.slice(2);
if (!version || !title || !changes.length) throw new Error('Usage : bump.mjs version titre changements...');
const L = JSON.parse(readFileSync(d + 'changelog.json', 'utf8'));
// heure de Paris, même si la machine est réglée sur une autre heure (cloud en UTC)
const parts = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  .formatToParts(new Date()).map((x) => [x.type, x.value]));
const date = parts.year + '-' + parts.month + '-' + parts.day;
const time = parts.hour + ':' + parts.minute;
L.releases.unshift({ version, date, time, title, changes });
L.version = version; L.date = date; L.time = time;
writeFileSync(d + 'changelog.json', JSON.stringify(L, null, 2) + '\n');
writeFileSync(d + 'sw.js', readFileSync(d + 'sw.js', 'utf8').replace(/var V = 'maison-[^']+';/, `var V = 'maison-${version}';`));
new Function(readFileSync(d + 'app.js', 'utf8'));
console.log('OK', version, date, time);
