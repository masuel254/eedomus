// Vérifie que le code JavaScript envoyé à n8n se compile, AVANT de déployer.
// Usage : node scripts/check-n8n-code.mjs   (code de sortie 1 si erreur)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'deploy-n8n.mjs'), 'utf8');
const start = src.indexOf('const code = `') + 'const code = `'.length;
const end = src.indexOf('`;', start);
// Reproduit l'évaluation du gabarit (les \n deviennent de vrais retours à la ligne, comme dans n8n)
const body = new Function('CODE_CFG', 'return `' + src.slice(start, end) + '`;')({});
try {
  new Function('$input', '$getWorkflowStaticData', 'Buffer', 'return (async function(){' + body + '\n});');
  console.log('Code n8n : syntaxe OK');
} catch (e) {
  console.error('Code n8n : ERREUR DE SYNTAXE ->', e.message);
  process.exit(1);
}
