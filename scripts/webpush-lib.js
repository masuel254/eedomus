// ---------------- Notifications iPhone (Web Push) ----------------
// Le nœud Code de n8n interdit le module crypto : la signature ES256 (ECDSA P-256 + SHA-256) exigée par Apple
// et le chiffrement du message (RFC 8291) sont donc écrits ici en JavaScript pur (BigInt).
// Le message voyage chiffré dans la notification ; les anciennes inscriptions (sans clé) viennent le chercher (push.pending).
const EC_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const EC_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const EC_G = [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n];
function ecMod(a, m) { const r = a % m; return r >= 0n ? r : r + m; }
function ecInv(a, m) { let [x0, x1, r0, r1] = [0n, 1n, m, ecMod(a, m)]; while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [x0, x1] = [x1, x0 - q * x1]; } return ecMod(x0, m); }
// Coordonnées jacobiennes (X, Y, Z) : une seule inversion à la fin, donc rapide
function ecDbl(P) {
  const [X, Y, Z] = P; if (Y === 0n) return [0n, 1n, 0n];
  const p = EC_P, YY = Y * Y % p, S = 4n * X * YY % p, Z2 = Z * Z % p, M = 3n * (X - Z2) * (X + Z2) % p;
  const X3 = ecMod(M * M - 2n * S, p), Y3 = ecMod(M * (S - X3) - 8n * YY * YY, p), Z3 = 2n * Y * Z % p;
  return [X3, Y3, Z3];
}
function ecAdd(P, Q) {
  if (P[2] === 0n) return Q; if (Q[2] === 0n) return P;
  const p = EC_P, Z1Z1 = P[2] * P[2] % p, Z2Z2 = Q[2] * Q[2] % p;
  const U1 = P[0] * Z2Z2 % p, U2 = Q[0] * Z1Z1 % p, S1 = P[1] * Q[2] % p * Z2Z2 % p, S2 = Q[1] * P[2] % p * Z1Z1 % p;
  if (U1 === U2) return S1 === S2 ? ecDbl(P) : [0n, 1n, 0n];
  const H = ecMod(U2 - U1, p), R = ecMod(S2 - S1, p), HH = H * H % p, HHH = H * HH % p, V = U1 * HH % p;
  const X3 = ecMod(R * R - HHH - 2n * V, p), Y3 = ecMod(R * (V - X3) - S1 * HHH, p), Z3 = P[2] * Q[2] % p * H % p;
  return [X3, Y3, Z3];
}
function ecMulG(k) {
  let R = [0n, 1n, 0n], A = [EC_G[0], EC_G[1], 1n];
  while (k > 0n) { if (k & 1n) R = ecAdd(R, A); A = ecDbl(A); k >>= 1n; }
  const zi = ecInv(R[2], EC_P), zi2 = zi * zi % EC_P;
  return [R[0] * zi2 % EC_P, R[1] * zi2 % EC_P * zi % EC_P];
}
function bytesToBig(b) { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; }
function bigToBytes(n, len) { const out = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; }
function catBytes() { const parts = Array.from(arguments), out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; parts.forEach((p) => { out.set(p, o); o += p.length; }); return out; }
function hmacBytes(key, msg) {
  let k = key; if (k.length > 64) k = sha256Bytes(k);
  const kp = new Uint8Array(64); kp.set(k);
  return sha256Bytes(catBytes(kp.map((x) => x ^ 0x5c), sha256Bytes(catBytes(kp.map((x) => x ^ 0x36), msg))));
}
function b64url(bytes) { return Buffer.from(bytes).toString('base64').replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { return new Uint8Array(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')); }
// Signature ECDSA P-256 / SHA-256, nombre aléatoire k déterministe (RFC 6979) : pas besoin de générateur aléatoire sûr
function es256Sign(msgBytes, dBytes) {
  const d = bytesToBig(dBytes), h = sha256Bytes(msgBytes), e = bytesToBig(h) % EC_N;
  const x = bigToBytes(d, 32), h1 = bigToBytes(e, 32);
  let V = new Uint8Array(32).fill(1), K = new Uint8Array(32);
  K = hmacBytes(K, catBytes(V, [0], x, h1)); V = hmacBytes(K, V);
  K = hmacBytes(K, catBytes(V, [1], x, h1)); V = hmacBytes(K, V);
  for (;;) {
    V = hmacBytes(K, V);
    const k = bytesToBig(V);
    if (k >= 1n && k < EC_N) {
      const r = ecMulG(k)[0] % EC_N;
      const s = ecInv(k, EC_N) * ecMod(e + r * d, EC_N) % EC_N;
      if (r !== 0n && s !== 0n) return catBytes(bigToBytes(r, 32), bigToBytes(s, 32));
    }
    K = hmacBytes(K, catBytes(V, [0])); V = hmacBytes(K, V);
  }
}
// Jeton VAPID (valable 12 h) pour un service de notification (Apple, Google, Mozilla)
function vapidJwt(endpoint, push) {
  const aud = String(endpoint).match(/^https:[/][/][^/]+/)[0]; // URL() n'existe pas dans n8n
  const enc = (o) => b64url(utf8(JSON.stringify(o)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: push.sub });
  return unsigned + '.' + b64url(es256Sign(utf8(unsigned), b64urlDecode(push.d)));
}

// ---------------- Contenu chiffré (RFC 8291, aes128gcm), en JavaScript pur ----------------
// L'iPhone n'affiche le bon texte que s'il est DANS la notification : on le chiffre avec la clé de l'iPhone (p256dh + auth).
function ecMulPt(P, k) {
  let R = [0n, 1n, 0n], A = [P[0], P[1], 1n];
  while (k > 0n) { if (k & 1n) R = ecAdd(R, A); A = ecDbl(A); k >>= 1n; }
  const zi = ecInv(R[2], EC_P), zi2 = zi * zi % EC_P;
  return [R[0] * zi2 % EC_P, R[1] * zi2 % EC_P * zi % EC_P];
}
// AES-128 : table S calculée (inverse dans GF(2^8) puis transformation affine)
const AES_S = (function () {
  const s = new Uint8Array(256); let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
    const r = (x, n) => ((x << n) | (x >> (8 - n))) & 0xff;
    s[p] = q ^ r(q, 1) ^ r(q, 2) ^ r(q, 3) ^ r(q, 4) ^ 0x63;
  } while (p !== 1);
  s[0] = 0x63; return s;
})();
function aesKeys(key) {
  const w = new Uint8Array(176); w.set(key); let rc = 1;
  for (let i = 16; i < 176; i += 4) {
    let t = w.slice(i - 4, i);
    if (i % 16 === 0) { t = new Uint8Array([AES_S[t[1]] ^ rc, AES_S[t[2]], AES_S[t[3]], AES_S[t[0]]]); rc = (rc << 1) ^ (rc & 0x80 ? 0x11b : 0); }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j] ^ t[j];
  }
  return w;
}
function aesBlock(w, inp) {
  const s = new Uint8Array(16), xt = (x) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
  for (let i = 0; i < 16; i++) s[i] = inp[i] ^ w[i];
  for (let r = 1; r <= 10; r++) {
    const t = new Uint8Array(16);
    for (let i = 0; i < 16; i++) t[i] = AES_S[s[(i + 4 * (i % 4)) % 16]]; // SubBytes + ShiftRows
    if (r < 10) for (let c = 0; c < 4; c++) {
      const a0 = t[4 * c], a1 = t[4 * c + 1], a2 = t[4 * c + 2], a3 = t[4 * c + 3], x = a0 ^ a1 ^ a2 ^ a3;
      t[4 * c] = a0 ^ x ^ xt(a0 ^ a1); t[4 * c + 1] = a1 ^ x ^ xt(a1 ^ a2); t[4 * c + 2] = a2 ^ x ^ xt(a2 ^ a3); t[4 * c + 3] = a3 ^ x ^ xt(a3 ^ a0);
    }
    for (let i = 0; i < 16; i++) s[i] = t[i] ^ w[16 * r + i];
  }
  return s;
}
// GCM (chiffrement seul, sans données associées) : renvoie texte chiffré + étiquette de 16 octets
function aesGcm(key, iv, data) {
  const w = aesKeys(key), H = bytesToBig(aesBlock(w, new Uint8Array(16))), R = 0xe1n << 120n;
  const gmul = (X) => { let Z = 0n, V = H; for (let i = 127; i >= 0; i--) { if ((X >> BigInt(i)) & 1n) Z ^= V; V = V & 1n ? (V >> 1n) ^ R : V >> 1n; } return Z; };
  const ctr = (n) => catBytes(iv, bigToBytes(BigInt(n), 4));
  const out = new Uint8Array(data.length);
  for (let o = 0, n = 2; o < data.length; o += 16, n++) { const ks = aesBlock(w, ctr(n)); for (let i = 0; i < 16 && o + i < data.length; i++) out[o + i] = data[o + i] ^ ks[i]; }
  let Y = 0n;
  for (let o = 0; o < out.length; o += 16) { const blk = new Uint8Array(16); blk.set(out.slice(o, o + 16)); Y = gmul(Y ^ bytesToBig(blk)); }
  Y = gmul(Y ^ BigInt(out.length * 8));
  const tag = bigToBytes(Y, 16), e0 = aesBlock(w, ctr(1));
  return catBytes(out, tag.map((x, i) => x ^ e0[i]));
}
// Octets imprévisibles : HMAC de la clé privée du serveur (secrète) sur l'heure, un compteur et Math.random
let wpSeq = 0;
function wpRandom(secret, n) { return hmacBytes(secret, utf8(Date.now() + ':' + (wpSeq++) + ':' + Math.random() + ':' + Math.random())).slice(0, n); }
function b64std(bytes) { return Buffer.from(bytes).toString('base64'); }
function webPushEncrypt(plain, p256dh, auth, secret) {
  const ua = b64urlDecode(p256dh), au = b64urlDecode(auth);
  let x = 0n; while (x <= 0n || x >= EC_N) x = bytesToBig(wpRandom(secret, 32)) % EC_N;
  const A = ecMulG(x), asPub = catBytes([4], bigToBytes(A[0], 32), bigToBytes(A[1], 32));
  const S = ecMulPt([bytesToBig(ua.slice(1, 33)), bytesToBig(ua.slice(33, 65))], x), ecdh = bigToBytes(S[0], 32);
  const prkKey = hmacBytes(au, ecdh);
  const ikm = hmacBytes(prkKey, catBytes(utf8('WebPush: info'), [0], ua, asPub, [1]));
  const salt = wpRandom(secret, 16), prk = hmacBytes(salt, ikm);
  const cek = hmacBytes(prk, catBytes(utf8('Content-Encoding: aes128gcm'), [0], [1])).slice(0, 16);
  const nonce = hmacBytes(prk, catBytes(utf8('Content-Encoding: nonce'), [0], [1])).slice(0, 12);
  const body = aesGcm(cek, nonce, catBytes(plain, [2]));
  return catBytes(salt, [0, 0, 16, 0], [65], asPub, body);
}
