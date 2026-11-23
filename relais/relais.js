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
  let m = /(20[0-9]{2})[-_.]?([01][0-9])[-_.]?([0-3][0-9])[-_T. ]?([0-2][0-9])[-_.:h]?([0-5][0-9])(?:[-_.:m]?([0-5][0-9])(?![0-9A-Za-z]))?/.exec(b);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
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
      if (u.pathname === '/api/summary' || u.pathname === '/api/summary/build') {
        const date = u.searchParams.get('date') || '';
        if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return json(res, 403, { ok: false, error: 'not_allowed' });
        if (u.pathname === '/api/summary/build') startSummary(date);
        return json(res, 200, sumState(date));
      }
      const rs = /^\/v\/resume\/([0-9]{4}-[0-9]{2}-[0-9]{2}\.mp4)$/.exec(u.pathname);
      if (rs) return sendFile(req, res, SUMDIR(), rs[1]);
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
  cleanPresence();
  cleanSummaries();
  nightlySummary();
}
// Vidéos de la Présence : rangées par Netatmo dans PRESENCE_DIR/AAAA/MM/JJ/. On ne supprime que les vidéos
// de ces dossiers datés, au-delà de PRESENCE_RETENTION_DAYS (0 ou absent : on ne supprime rien).
function cleanPresence() {
  const root = PRES(), days = Number(E.PRESENCE_RETENTION_DAYS) || 0;
  if (!root || days < 7) return;
  const limit = new Date(Date.now() - days * 86400000), lim = limit.getFullYear() * 10000 + (limit.getMonth() + 1) * 100 + limit.getDate();
  const ls = (d) => { try { return fs.readdirSync(d).filter((n) => /^[0-9]+$/.test(n)); } catch (e) { return []; } };
  let gone = 0;
  ls(root).filter((y) => y.length === 4).forEach((y) => ls(path.join(root, y)).filter((mo) => mo.length === 2).forEach((mo) => {
    ls(path.join(root, y, mo)).filter((d) => d.length === 2).forEach((d) => {
      if (Number(y + mo + d) >= lim) return;
      const dir = path.join(root, y, mo, d);
      let names = []; try { names = fs.readdirSync(dir); } catch (e) { return; }
      names.filter((n) => /\.(mp4|m4v|mov|jpg)$/i.test(n)).forEach((n) => { try { fs.unlinkSync(path.join(dir, n)); gone++; } catch (e) {} });
      try { fs.rmdirSync(dir); } catch (e) { /* pas vide : on laisse */ }
    });
    try { fs.rmdirSync(path.join(root, y, mo)); } catch (e) {}
  }));
  if (gone) console.log('Présence : ' + gone + ' vieille(s) vidéo(s) supprimée(s)');
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
  // réglages décidés côté serveur (durées de conservation)
  const C = j.cfg || {};
  [['RETENTION_DAYS', C.retention], ['PRESENCE_RETENTION_DAYS', C.presRetention]].forEach(([k, v]) => {
    if (Number(v) >= 7 && Number(v) <= 365 && String(E[k]) !== String(v)) { saveEnv(k, Number(v)); console.log(k + ' = ' + v); }
  });
  // nouveau nom internet décidé côté serveur : certificat HTTPS (Caddy) et adresse annoncée
  if (C.host && /^[a-z0-9-]+([.][a-z0-9-]+)+$/.test(C.host) && 'https://' + C.host !== E.PUBLIC_URL) {
    fs.writeFileSync('/etc/caddy/Caddyfile', '# Relais caméras : HTTPS automatique (certificat Let\'s Encrypt), tout est transmis au relais\n' +
      C.host + ' {\n\treverse_proxy 127.0.0.1:' + (Number(E.PORT) || 8080) + '\n}\n');
    require('child_process').execFileSync('systemctl', ['restart', 'caddy']);
    saveEnv('PUBLIC_URL', 'https://' + C.host); E = loadEnv();
    console.log('Nouveau nom : ' + C.host);
    await new Promise((ok) => setTimeout(ok, 20000)); // le temps d'obtenir le certificat
    return hello();
  }
}
async function pair(code) {
  const j = await post({ action: 'relay.hello', url: E.PUBLIC_URL, code: String(code).replace(/[^0-9]/g, '') });
  if (!j.secret) throw new Error('réponse sans clé');
  saveEnv('SECRET', j.secret);
  fs.writeFileSync('/etc/relais/imou.json', JSON.stringify(j.cams || [], null, 1));
  console.log('Jumelage réussi : ' + (j.cams || []).length + ' caméra(s) Imou connue(s) du serveur');
}

// ---------- Résumé vidéo de la journée : les passages de personnes, toutes caméras, mis bout à bout ----------
// Les moments viennent du serveur (détections « personne » d'Imou et de Netatmo), les images des enregistrements gardés ici.
// Chaque passage est recadré en 640×360 et légendé (caméra, heure), puis tout est mis bout à bout.
const { spawn, spawnSync } = require('child_process');
const SUMDIR = () => path.join(REC(), '_resumes');
const SPEED = 1; // film à vitesse réelle : l'appli le lit en accéléré (×4 par défaut)
function sumPaths(date) { const d = SUMDIR(); return { mp4: path.join(d, date + '.mp4'), json: path.join(d, date + '.json'), lock: path.join(d, date + '.building') }; }
function sumState(date) {
  const P = sumPaths(date);
  let info = null; try { info = JSON.parse(fs.readFileSync(P.json, 'utf8')); } catch (e) {}
  let building = false;
  try { const st = fs.statSync(P.lock); building = Date.now() - st.mtimeMs < 40 * 60000; } catch (e) {}
  const ready = !!info && fs.existsSync(P.mp4) && (info.speed || 1) === SPEED && info.v === 2; // ancien montage : refait
  return { ok: true, date, state: building ? 'building' : ready || (info && info.empty) ? 'ready' : info && info.error ? 'error' : 'none', building,
    url: ready ? '/v/resume/' + date + '.mp4?v=' + (info.builtAt || 0) : null, parts: ready ? info.parts : [], duration: ready ? info.duration : 0,
    builtAt: info ? info.builtAt || null : null, error: info && info.error ? info.error : null, progress: building ? readProgress(P.lock) : null };
}
function readProgress(lock) { try { return JSON.parse(fs.readFileSync(lock, 'utf8')); } catch (e) { return null; } }
function startSummary(date) {
  const P = sumPaths(date);
  fs.mkdirSync(SUMDIR(), { recursive: true });
  try { const st = fs.statSync(P.lock); if (Date.now() - st.mtimeMs < 40 * 60000) return false; } catch (e) {}
  fs.writeFileSync(P.lock, JSON.stringify({ step: 'démarrage', done: 0, total: 0 }));
  // lancé à part (systemd-run) : le montage continue même si le relais redémarre ou si le nettoyage se termine
  const r = spawnSync('systemd-run', ['--quiet', '--collect', '--unit', 'relais-resume-' + date + '-' + Date.now(), '--setenv=TZ=Europe/Paris',
    '--setenv=RELAIS_ENV=' + ENVF, '-p', 'Nice=10', process.execPath, __filename, 'summary', date], { timeout: 20000 });
  if (r.status !== 0) spawn(process.execPath, [__filename, 'summary', date], { detached: true, stdio: 'ignore', env: process.env }).unref();
  return true;
}
function probeDur(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 30000 });
  return Number(String(r.stdout || '').trim()) || 0;
}
function windows(times, before, after) { // fenêtres autour des détections, fusionnées quand elles se touchent
  const w = [];
  times.slice().sort((a, b) => a - b).forEach((t) => {
    const a = t - before, b = t + after, last = w[w.length - 1];
    if (last && a <= last[1] + 3) last[1] = Math.max(last[1], b); else w.push([a, b]);
  });
  return w;
}
async function buildSummary(date) {
  const T0 = Date.now(), P = sumPaths(date), progress = (o) => { try { fs.writeFileSync(P.lock, JSON.stringify(Object.assign({ t0: T0 }, o))); } catch (e) {} };
  progress({ step: 'recherche', done: 0, total: 0 });
  const ts = Math.floor(Date.now() / 1000);
  const ev = await post({ action: 'relay.events', date, ts, sig: crypto.createHmac('sha256', E.SECRET).update('events|' + date + '|' + ts).digest('hex') });
  const jobs = []; // { t0, cam, name, file, off, dur }
  // caméras Imou : tranches de 10 min gardées ici
  cams().forEach((c) => {
    const times = (ev.imou && ev.imou[c.id]) || [];
    if (!times.length) return;
    const dir = path.join(REC(), c.dir), day = date.replace(/-/g, '');
    let segs = [];
    try {
      segs = fs.readdirSync(dir).filter((n) => /^[0-9]{8}-[0-9]{6}\.mp4$/.test(n) && n.slice(0, 8) === day).map((n) => {
        const st = fs.statSync(path.join(dir, n));
        const b = new Date(+n.slice(0, 4), +n.slice(4, 6) - 1, +n.slice(6, 8), +n.slice(9, 11), +n.slice(11, 13), +n.slice(13, 15)).getTime() / 1000;
        return { file: path.join(dir, n), b, e: Math.min(st.mtimeMs / 1000, b + 3600), ok: complete(path.join(dir, n), st) };
      }).filter((g) => g.ok).sort((x, y) => x.b - y.b);
      segs.forEach((g, i) => { if (segs[i + 1]) g.e = Math.min(g.e, segs[i + 1].b); }); // une tranche s'arrête où commence la suivante
    } catch (e) {}
    windows(times, 4, 16).forEach(([a, b]) => {
      const g = segs.find((x) => a + 4 >= x.b && a + 4 < x.e); if (!g) return;
      const off = Math.max(0, a - g.b), dur = Math.min(b, g.e) - (g.b + off);
      if (dur >= 2) jobs.push({ t0: g.b + off, cam: c.id, name: c.name, file: g.file, off, dur });
    });
  });
  // Présence : clips déposés par Netatmo sur la Freebox
  if (PRES() && ev.presence && ev.presence.length) {
    const clips = presList().filter((c) => c.begin.slice(0, 10) === date);
    const durs = {};
    windows(ev.presence, 3, 12).forEach(([a, b]) => {
      const t = a + 3;
      const cl = clips.find((c) => {
        const f = path.join(PRES(), decodeURIComponent(c.url.slice('/v/presence/'.length)));
        const end = new Date(c.end.replace(' ', 'T')).getTime() / 1000;
        if (t > end + 5 || t < c.time - 90) return false;
        if (durs[f] === undefined) durs[f] = probeDur(f);
        c._f = f; c._s = end - durs[f];
        return t >= c._s - 5 && t <= end + 5;
      });
      if (!cl) return;
      const off = Math.max(0, a - cl._s), dur = Math.min(b - a, durs[cl._f] - off);
      if (dur >= 2) jobs.push({ t0: cl._s + off, cam: 'presence', name: 'Présence', file: cl._f, off, dur });
    });
  }
  jobs.sort((x, y) => x.t0 - y.t0);
  const tmp = fs.mkdtempSync('/var/tmp/resume-'), font = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find((f) => fs.existsSync(f));
  const parts = []; let at = 0;
  try {
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i], out = path.join(tmp, 'p' + String(i).padStart(4, '0') + '.mp4');
      progress({ step: 'montage', done: i, total: jobs.length });
      const d = new Date(j.t0 * 1000), hm = pad(d.getHours()) + 'h' + pad(d.getMinutes());
      // caméras Imou : flux 16:9 livré écrasé en 640×480, remis en 640×360 ; Présence : déjà en 16:9
      let vf = (j.cam === 'presence' ? 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2' : 'scale=640:360') + ',setsar=1,setpts=PTS/' + SPEED + ',fps=15';
      if (font) vf += ",drawtext=fontfile=" + font + ":text='" + (j.name + ' · ' + hm).replace(/[':\\]/g, ' ') + "':x=12:y=12:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6";
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(j.off), '-t', String(j.dur), '-i', j.file, '-an', '-vf', vf,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-r', '15', '-movflags', '+faststart', out], { timeout: 300000 });
      if (r.status !== 0 || !fs.existsSync(out)) continue;
      const pd = probeDur(out); if (!pd) continue;
      parts.push({ at: Math.round(at * 10) / 10, cam: j.cam, name: j.name, time: Math.floor(j.t0), file: out });
      at += pd;
    }
    fs.mkdirSync(SUMDIR(), { recursive: true });
    if (!parts.length) {
      fs.writeFileSync(P.json, JSON.stringify({ date, builtAt: Date.now(), parts: [], duration: 0, empty: true }));
      try { fs.unlinkSync(P.mp4); } catch (e) {}
      return;
    }
    progress({ step: 'assemblage', done: jobs.length, total: jobs.length });
    const list = path.join(tmp, 'liste.txt');
    fs.writeFileSync(list, parts.map((p) => "file '" + p.file + "'").join('\n') + '\n');
    const full = path.join(tmp, 'resume.mp4');
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', full], { timeout: 600000 });
    if (r.status !== 0) throw new Error('assemblage impossible');
    fs.copyFileSync(full, P.mp4 + '.tmp'); fs.renameSync(P.mp4 + '.tmp', P.mp4);
    fs.writeFileSync(P.json, JSON.stringify({ date, v: 2, builtAt: Date.now(), speed: SPEED, duration: Math.round(at), parts: parts.map((p) => ({ at: p.at, cam: p.cam, name: p.name, time: p.time })) }));
  } finally {
    spawnSync('rm', ['-rf', tmp]);
  }
}
// chaque nuit (après 1h), le résumé de la veille est préparé tout seul
function nightlySummary() {
  const now = new Date(); if (now.getHours() < 1 || !E.SECRET) return;
  const y = new Date(now.getTime() - 86400000), date = y.getFullYear() + '-' + pad(y.getMonth() + 1) + '-' + pad(y.getDate());
  const st = sumState(date);
  if (st.state === 'none') startSummary(date);
}
function cleanSummaries() {
  const days = Number(E.RETENTION_DAYS) || 14, lim = Date.now() - days * 86400000;
  let ns = []; try { ns = fs.readdirSync(SUMDIR()); } catch (e) { return; }
  ns.forEach((n) => { const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})\./.exec(n); if (m && new Date(+m[1], +m[2] - 1, +m[3]).getTime() < lim) { try { fs.unlinkSync(path.join(SUMDIR(), n)); } catch (e) {} } });
}

const cmd = process.argv[2] || 'serve';
if (cmd === 'serve') serve();
else if (cmd === 'clean') clean();
else if (cmd === 'hello') hello().catch((e) => { console.error('Serveur injoignable : ' + e.message); process.exit(1); });
else if (cmd === 'pair') pair(process.argv[3] || '').catch((e) => { console.error('Jumelage impossible : ' + e.message); process.exit(1); });
else if (cmd === 'status') console.log(JSON.stringify(status(), null, 1));
else if (cmd === 'summary') {
  const date = process.argv[3] || '';
  buildSummary(date).catch((e) => {
    try { fs.writeFileSync(sumPaths(date).json, JSON.stringify({ date, builtAt: Date.now(), error: String(e.message || e) })); } catch (x) {}
  }).finally(() => { try { fs.unlinkSync(sumPaths(date).lock); } catch (e) {} });
}
else { console.error('Usage : node relais.js [serve|clean|hello|pair CODE|status]'); process.exit(2); }
