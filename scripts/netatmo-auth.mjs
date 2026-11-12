// Autorisation Netatmo (OAuth2) en un clic.
// Ouvre la page d'autorisation Netatmo, récupère le code sur http://localhost:8766/callback,
// l'échange contre un refresh_token et l'enregistre dans .env (jamais publié).
// Usage : node scripts/netatmo-auth.mjs
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]])
);

const PORT = 8766;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = 'read_presence access_presence read_thermostat write_thermostat';
const state = randomBytes(12).toString('hex');

const authUrl = 'https://api.netatmo.com/oauth2/authorize?' + new URLSearchParams({
  client_id: env.NETATMO_CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPES, state,
});

function setEnv(key, value) {
  let txt = readFileSync(envPath, 'utf8');
  const line = `${key}=${value}`;
  txt = new RegExp(`^${key}=.*$`, 'm').test(txt) ? txt.replace(new RegExp(`^${key}=.*$`, 'm'), line) : txt.replace(/\s*$/, '\n') + line + '\n';
  writeFileSync(envPath, txt);
}

const page = (title, msg) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="background:#0C0E11;color:#EEF0F3;font-family:Segoe UI,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>${title}</h1><p style="color:#8B94A1">${msg}</p></div>`;

const server = createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
    res.end(page('Autorisation refusée', 'Netatmo n\'a pas donné son accord. Relance l\'autorisation.'));
    console.log('ERREUR: ' + (u.searchParams.get('error') || 'code absent'));
    return finish(1);
  }
  try {
    const r = await fetch('https://api.netatmo.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: env.NETATMO_CLIENT_ID, client_secret: env.NETATMO_CLIENT_SECRET,
        code: u.searchParams.get('code'), redirect_uri: REDIRECT, scope: SCOPES,
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) throw new Error(JSON.stringify(j));
    setEnv('NETATMO_REFRESH_TOKEN', j.refresh_token);
    res.end(page('C\'est bon ✅', 'Netatmo est relié. Tu peux fermer cet onglet et revenir à Claude.'));
    console.log('OK: refresh_token enregistré dans .env (scopes: ' + (j.scope || []).join(' ') + ')');
    finish(0);
  } catch (e) {
    res.end(page('Erreur', 'L\'échange avec Netatmo a échoué.'));
    console.log('ERREUR: ' + e.message);
    finish(1);
  }
});

function finish(code) { setTimeout(() => { server.close(); process.exit(code); }, 300); }

server.listen(PORT, '127.0.0.1', () => {
  console.log('En attente de l\'autorisation sur ' + REDIRECT);
  spawn('cmd', ['/c', 'start', '', authUrl.replace(/&/g, '^&')], { stdio: 'ignore', detached: true }).unref();
});
setTimeout(() => { console.log('ERREUR: délai dépassé (5 min)'); finish(1); }, 5 * 60 * 1000);
