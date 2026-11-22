// Relais caméras : tourne dans la machine virtuelle (Debian) de la Freebox.
// - sert les enregistrements Imou (morceaux de 10 min) et les clips de la Présence déposés sur la Freebox,
//   derrière Caddy (HTTPS), uniquement avec un jeton signé délivré par le serveur n8n (valable 1 jour) ;
// - « node relais.js hello » : se signale au serveur n8n (adresse publique, état), toutes les 15 min ;
// - « node relais.js pair CODE » : jumelage avec l'appli (code affiché dans Réglages) ;
// - « node relais.js clean » : supprime les vieux enregistrements (au-delà de RETENTION_DAYS, ou si le disque se remplit).
// Aucun module à installer (Node 18 de Debian). Réglages : /etc/relais/relais.env et /etc/relais/cameras.conf.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const ENVF = process.env.RELAIS_ENV || '/etc/relais/relais.env';
function loadEnv() {
  const e = {};
  try {
    fs.readFileSync(ENVF, 'utf8').split(/\r?\n/).forEach((l) => {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) e[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    });
  } catch (x) { /* pas encore installé */ }
  return e;
}
function saveEnv(key, value) {
  let t = ''; try { t = fs.readFileSync(ENVF, 'utf8'); } catch (x) {}
  const line = key + '="' + String(value).replace(/"/g, '') + '"';
  const re = new RegExp('^' + key + '=.*$', 'm');
  t = re.test(t) ? t.replace(re, line) : t + (t && !t.endsWith('\n') ? '\n' : '') + line + '\n';
  fs.writeFileSync(ENVF, t, { mode: 0o600 });
}
let E = loadEnv();
const REC = () => E.REC_DIR || '/srv/relais/imou';
const PRES = () => E.PRESENCE_DIR || '';
const CAMS_FILE = '/etc/relais/cameras.conf';

function safeDir(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '_'); }
function cams() { // une ligne par caméra : id Imou|nom|adresse rtsp
  try {
    return fs.readFileSync(CAMS_FILE, 'utf8').split(/\r?\n/).filter((l) => l.trim() && l[0] !== '#')
      .map((l) => { const p = l.split('|'); return { id: p[0], name: p[1] || p[0], dir: safeDir(p[0]) }; });
  } catch (e) { return []; }
}
const pad = (n) => String(n).padStart(2, '0');
function local(d) { // la VM est réglée sur l'heure de Paris
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// ---------- Jeton : « échéance.signature », signature = HMAC-SHA256(SECRET, 'relais|' + échéance) ----------
function okToken(t) {
  const m = /^([0-9]{9,11})\.([0-9a-f]{64})$/.exec(String(t || ''));
  if (!m || !E.SECRET) return false;
  const exp = Number(m[1]), now = Date.now() / 1000;
  if (exp < now || exp > now + 3 * 86400) return false;
  const want = crypto.createHmac('sha256', E.SECRET).update('relais|' + m[1]).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]));
}

// ---------- Enregistrements Imou : REC_DIR/<caméra>/AAAAMMJJ-HHMMSS.mp4 ----------
// Un morceau terminé commence par « ftyp » puis « moov » (ffmpeg le réécrit ainsi à la fin des 10 min) :
// sinon il est encore en cours d'écriture, ou a été coupé net (illisible), et on ne le montre pas.
const headOk = new Map();
function complete(p, st) {
  const k = p + '|' + st.size;
  if (headOk.has(k)) return headOk.get(k);
  let ok = false;
  try {
    const fd = fs.openSync(p, 'r'), b = Buffer.alloc(64); fs.readSync(fd, b, 0, 64, 0); fs.closeSync(fd);
    const n = b.readUInt32BE(0);
    ok = b.toString('latin1', 4, 8) === 'ftyp' && n >= 8 && n <= 56 && b.toString('latin1', n + 4, n + 8) === 'moov';
  } catch (e) {}
  if (ok || Date.now() - st.mtimeMs > 900000) { headOk.set(k, ok); if (headOk.size > 30000) headOk.clear(); }
  return ok;
}
function imouDay(cam, date) {
  const dir = path.join(REC(), safeDir(cam));
  const day = date.replace(/-/g, '');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^[0-9]{8}-[0-9]{6}\.mp4$/.test(n)).sort(); } catch (e) { return { records: [], recording: false }; }
  const out = []; let recording = false;
  names.forEach((n, i) => {
    if (n.slice(0, 8) !== day) return;
    let st; try { st = fs.statSync(path.join(dir, n)); } catch (e) { return; }
    // le morceau en cours d'écriture n'est pas encore lisible (il le sera à la fin des 10 min)
    if (st.size < 20000 || !complete(path.join(dir, n), st)) { if (i === names.length - 1) recording = true; return; }
    const b = new Date(+n.slice(0, 4), +n.slice(4, 6) - 1, +n.slice(6, 8), +n.slice(9, 11), +n.slice(11, 13), +n.slice(13, 15));
    const e = st.mtimeMs > b.getTime() && st.mtimeMs - b.getTime() < 3600000 ? new Date(st.mtimeMs) : new Date(b.getTime() + 600000);
    out.push({ begin: local(b), end: local(e), type: 'regular', size: st.size, url: '/v/imou/' + safeDir(cam) + '/' + n });
  });
  out.reverse();
  return { records: out, recording };
}

// ---------- Clips de la Présence (dossier FTP sur la Freebox) ----------
// Plus de 20 000 vidéos sur le disque réseau : on garde un index en mémoire, et on ne relit que les dossiers modifiés.
let presCache = { at: 0, list: [] };
const presDirs = {}; // dossier -> { mtime, clips: [...], subs: [...] }
function clipTime(rel, st) {
  // date dans le nom (2026-11-22_18-05-03, 20261122_180503…) ou nombre de secondes ; sinon date du fichier
  const b = path.basename(rel);
  let m = /(20[0-9]{2})[-_.]?([01][0-9])[-_.]?([0-3][0-9])[-_T. ]?([0-2][0-9])[-_.:h]?([0-5][0-9])[-_.:m]?([0-5][0-9])/.exec(b);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  m = /(1[6-9][0-9]{8})/.exec(b);
  if (m) return new Date(+m[1] * 1000);
  return new Date(st.mtimeMs);
}
function presScanDir(root, d, depth, out) {
  let dst; try { dst = fs.statSync(d); } catch (e) { return; }
  let c = presDirs[d];
  if (!c || c.mtime !== dst.mtimeMs) {
    c = { mtime: dst.mtimeMs, clips: [], subs: [] };
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    ents.forEach((en) => {
      const p = path.join(d, en.name);
      if (en.isDirectory()) { if (depth < 6) c.subs.push(p); return; }
      if (!/\.(mp4|m4v|mov)$/i.test(en.name)) return;
      let st; try { st = fs.statSync(p); } catch (e) { return; }
      if (st.size < 20000 || Date.now() - st.mtimeMs < 10000) { c.mtime = -1; return; } // encore en cours d'envoi : dossier relu la prochaine fois
      const rel = path.relative(root, p), t = clipTime(rel, st);
      c.clips.push({ time: Math.floor(t.getTime() / 1000), begin: local(t), end: local(new Date(Math.max(st.mtimeMs, t.getTime()))), size: st.size,
        url: '/v/presence/' + rel.split(path.sep).map(encodeURIComponent).join('/') });
    });
    presDirs[d] = c;
  }
  c.clips.forEach((x) => out.push(x));
  c.subs.forEach((sd) => presScanDir(root, sd, depth + 1, out));
}
function presRefresh() {
  const root = PRES(), list = [];
  if (root) presScanDir(root, root, 0, list);
  list.sort((a, b) => b.time - a.time);
  presCache = { at: Date.now(), list };
}
function presList() {
  if (!presCache.at) presRefresh();
  else if (Date.now() - presCache.at > 30000 && !presCache.busy) { presCache.busy = true; setImmediate(presRefresh); } // mise à jour derrière, on répond tout de suite
  return presCache.list;
}

// ---------- État (pour Réglages dans l'appli et pour le serveur) ----------
let statusCache = { at: 0, data: null };
function status() {
  if (statusCache.data && Date.now() - statusCache.at < 60000) return statusCache.data;
  let disk = null;
  try { const s = fs.statfsSync(REC()); disk = { freeGb: Math.round(s.bavail * s.bsize / 1e9), totalGb: Math.round(s.blocks * s.bsize / 1e9) }; } catch (e) {}
  const list = cams().map((c) => {
    let names = []; try { names = fs.readdirSync(path.join(REC(), c.dir)).filter((n) => /\.mp4$/.test(n)).sort(); } catch (e) {}
    let last = null, bytes = 0;
    names.forEach((n) => { try { const st = fs.statSync(path.join(REC(), c.dir, n)); bytes += st.size; last = st.mtimeMs; } catch (e) {} });
    return { id: c.id, name: c.name, files: names.length, gb: Math.round(bytes / 1e8) / 10, lastWrite: last ? Math.floor(last / 1000) : null,
      ok: !!last && Date.now() - last < 120000, from: names[0] ? names[0].slice(0, 8) : null };
  });
  const pl = presList();
  const data = { ok: true, version: 1, disk, retention: +E.RETENTION_DAYS || 14, cams: list, presence: { dir: !!PRES(), clips: pl.length, last: pl[0] ? pl[0].time : null } };
  statusCache = { at: Date.now(), data };
  return data;
}

// ---------- Serveur HTTP (Caddy fait le HTTPS devant) ----------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length' };
function json(res, code, data) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS));
  res.end(JSON.stringify(data));
}
function sendFile(req, res, root, rel) {
  const base = path.resolve(root), file = path.resolve(base, rel);
  if (!root || !file.startsWith(base + path.sep)) return json(res, 403, { ok: false, error: 'not_allowed' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { ok: false, error: 'not_found' });
    const h = Object.assign({ 'Content-Type': /\.mov$/i.test(file) ? 'video/quicktime' : 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' }, CORS);
    const m = /^bytes=([0-9]*)-([0-9]*)$/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1, code = 200;
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') start = Math.max(0, st.size - Number(m[2]));
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), st.size - 1); }
      if (start > end || start >= st.size) { res.writeHead(416, Object.assign({ 'Content-Range': 'bytes */' + st.size }, CORS)); return res.end(); }
      code = 206; h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    }
    h['Content-Length'] = end - start + 1;
    res.writeHead(code, h);
    if (req.method === 'HEAD') return res.end();
    const s = fs.createReadStream(file, { start, end });
    s.on('error', () => res.destroy());
    res.on('close', () => s.destroy());
    s.pipe(res);
  });
}
function serve() {
  const port = Number(E.PORT) || 8080;
  http.createServer((req, res) => {
    let u; try { u = new URL(req.url, 'http://x'); } catch (e) { return json(res, 400, { ok: false }); }
    if (req.method === 'OPTIONS') { res.writeHead(204, Object.assign({ 'Access-Control-Allow-Methods': 'GET, HEAD' }, CORS)); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false });
    if (u.pathname === '/ping') return json(res, 200, { ok: true }); // seul accès sans jeton (vérifier que le relais répond)
    if (!okToken(u.searchParams.get('t'))) return json(res, 401, { ok: false, error: 'unauthorized' });
    try {
      if (u.pathname === '/api/status') return json(res, 200, status());
      if (u.pathname === '/api/imou') {
        const cam = u.searchParams.get('cam') || '', date = u.searchParams.get('date') || '';
        if (!cams().some((c) => c.id === cam) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return json(res, 403, { ok: false, error: 'not_allowed' });
        const r = imouDay(cam, date);
        return json(res, 200, { ok: true, cam, date, records: r.records, recording: r.recording });
      }
      if (u.pathname === '/api/presence') {
        const date = u.searchParams.get('date') || '';
        const all = presList();
        return json(res, 200, { ok: true, date, clips: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date) ? all.filter((c) => c.begin.slice(0, 10) === date) : all.slice(0, 200) });
      }
      let m = /^\/v\/imou\/([A-Za-z0-9_-]+)\/([0-9]{8}-[0-9]{6}\.mp4)$/.exec(u.pathname);
      if (m) return sendFile(req, res, REC(), m[1] + '/' + m[2]);
      if (u.pathname.indexOf('/v/presence/') === 0) {
        const rel = u.pathname.slice('/v/presence/'.length).split('/').map(decodeURIComponent).join('/');
        if (/(^|\/)\.\.?(\/|$)/.test(rel)) return json(res, 403, { ok: false });
        return sendFile(req, res, PRES(), rel);
      }
    } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
    json(res, 404, { ok: false, error: 'not_found' });
  }).listen(port, '127.0.0.1', () => { console.log('Relais caméras à l’écoute sur 127.0.0.1:' + port); setTimeout(presRefresh, 1000); });
  setInterval(() => { E = loadEnv(); }, 60000); // réglages relus sans redémarrer
}

// ---------- Nettoyage ----------
function clean() {
  const days = Number(E.RETENTION_DAYS) || 14, minFree = (Number(E.MIN_FREE_GB) || 30) * 1e9;
  const limit = Date.now() - days * 86400000, files = [];
  let dirs = []; try { dirs = fs.readdirSync(REC()); } catch (e) { return; }
  dirs.forEach((d) => {
    let ns = []; try { ns = fs.readdirSync(path.join(REC(), d)); } catch (e) { return; }
    ns.filter((n) => /^[0-9]{8}-[0-9]{6}\.mp4$/.test(n)).forEach((n) => files.push({ p: path.join(REC(), d, n), n }));
  });
  files.sort((a, b) => (a.n < b.n ? -1 : 1));
  let gone = 0;
  files.forEach((f) => {
    const b = new Date(+f.n.slice(0, 4), +f.n.slice(4, 6) - 1, +f.n.slice(6, 8), +f.n.slice(9, 11), +f.n.slice(11, 13));
    if (b.getTime() < limit) { try { fs.unlinkSync(f.p); gone++; } catch (e) {} f.gone = true; }
  });
  // disque presque plein : on supprime les plus anciens, toutes caméras confondues
  const free = () => { try { const s = fs.statfsSync(REC()); return s.bavail * s.bsize; } catch (e) { return Infinity; } };
  for (const f of files) { if (free() >= minFree) break; if (f.gone) continue; try { fs.unlinkSync(f.p); gone++; } catch (e) {} }
  console.log('Nettoyage : ' + gone + ' fichier(s) supprimé(s)');
}

// ---------- Échanges avec le serveur n8n ----------
async function post(body) {
  if (!E.API) throw new Error('API absente dans ' + ENVF);
  const r = await fetch(E.API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
  return j;
}
async function hello() {
  const ts = Math.floor(Date.now() / 1000), url = E.PUBLIC_URL;
  const sig = crypto.createHmac('sha256', E.SECRET).update('hello|' + url + '|' + ts).digest('hex');
  let st = null; try { st = status(); } catch (e) {}
  const j = await post({ action: 'relay.hello', url, ts, sig, status: st });
  console.log('Serveur prévenu : ' + (j.url || url));
}
async function pair(code) {
  const j = await post({ action: 'relay.hello', url: E.PUBLIC_URL, code: String(code).replace(/[^0-9]/g, '') });
  if (!j.secret) throw new Error('réponse sans clé');
  saveEnv('SECRET', j.secret);
  fs.writeFileSync('/etc/relais/imou.json', JSON.stringify(j.cams || [], null, 1));
  console.log('Jumelage réussi : ' + (j.cams || []).length + ' caméra(s) Imou connue(s) du serveur');
}

const cmd = process.argv[2] || 'serve';
if (cmd === 'serve') serve();
else if (cmd === 'clean') clean();
else if (cmd === 'hello') hello().catch((e) => { console.error('Serveur injoignable : ' + e.message); process.exit(1); });
else if (cmd === 'pair') pair(process.argv[3] || '').catch((e) => { console.error('Jumelage impossible : ' + e.message); process.exit(1); });
else if (cmd === 'status') console.log(JSON.stringify(status(), null, 1));
else { console.error('Usage : node relais.js [serve|clean|hello|pair CODE|status]'); process.exit(2); }
