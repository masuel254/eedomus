#!/bin/bash
# Transcription (en français) de ce qui se dit dans une vidéo, faite sur la Freebox : le son ne sort pas de la maison.
# Usage : transcribe.sh <vidéo> <fichier résultat .json> [début (s) durée (s) [vidéo suivante]]
# (avec début et durée : seulement le moment d'un mouvement, éventuellement à cheval sur la tranche suivante)
# 1. son extrait (16 kHz, mono) ; 2. seuls les passages où quelqu'un parle sont gardés (le reste est du silence ou du bruit) ;
# 3. chaque passage est transcrit par Whisper (whisper.cpp, modèle « small » compressé) ; 4. résultat : phrases avec leur heure.
IN="$1"; OUT="$2"; A0="$3"; D0="$4"; IN2="$5"
W=/opt/relais/whisper; BIN=$W/whisper-cli; MODEL=$W/ggml-small-q5_1.bin
T=$(mktemp -d /var/tmp/tr-XXXXXX); trap 'rm -rf "$T"' EXIT; : > "$T/lines.txt"
# avancement, avec les phrases déjà trouvées (affichées au fur et à mesure)
step() { python3 - "$1" "${2:-0}" "${3:-0}" "$T/lines.txt" "$OUT.tmp" <<'PY'
import json, sys
try: lines = [json.loads(l) for l in open(sys.argv[4]) if l.strip()]
except Exception: lines = []
json.dump({'state': 'building', 'step': sys.argv[1], 'done': int(sys.argv[2]), 'total': int(sys.argv[3]), 'lines': lines}, open(sys.argv[5], 'w'), ensure_ascii=False)
PY
mv -f "$OUT.tmp" "$OUT"; }
fail() { printf '{"state":"error","error":"%s"}\n' "$1" > "$OUT.tmp" && mv -f "$OUT.tmp" "$OUT"; exit 0; }
# tous les cœurs : la tâche a une priorité minimale, les enregistrements et l'appli passent toujours avant
TH=$(nproc)
[ -x "$BIN" ] && [ -s "$MODEL" ] || fail "reconnaissance vocale pas encore installée (quelques minutes après la mise à jour)"
# une seule transcription à la fois (sinon la mémoire de la VM déborde) : les autres attendent leur tour
step attente
exec 9> /var/lib/relais/tr.lock; flock 9
step son
F="highpass=f=120,lowpass=f=7000"
if [ -n "$D0" ] && [ -n "$IN2" ]; then
  # mouvement à cheval sur deux tranches : fin de la première + début de la suivante
  ffmpeg -v error -y -ss "$A0" -i "$IN" -i "$IN2" -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1,atrim=0:$D0,$F" -ac 1 -ar 16000 "$T/r.wav" || fail "pas de son dans cette vidéo"
elif [ -n "$D0" ]; then
  ffmpeg -v error -y -ss "$A0" -t "$D0" -i "$IN" -vn -af "$F" -ac 1 -ar 16000 "$T/r.wav" || fail "pas de son dans cette vidéo"
else
  ffmpeg -v error -y -i "$IN" -vn -af "$F" -ac 1 -ar 16000 "$T/r.wav" || fail "pas de son dans cette vidéo"
fi
[ -s "$T/r.wav" ] || fail "pas de son dans cette vidéo"
# seuil de silence adapté au bruit de fond de la vidéo : on ne garde que ce qui est plus fort que le niveau moyen
MEAN=$(ffmpeg -i "$T/r.wav" -af volumedetect -f null - 2>&1 | sed -n 's/.*mean_volume: \(-[0-9.]*\) dB.*/\1/p' | cut -d. -f1)
TH_DB=$(( ${MEAN:--40} + 2 )); [ "$TH_DB" -gt -24 ] && TH_DB=-24; [ "$TH_DB" -lt -45 ] && TH_DB=-45
ffmpeg -v error -y -i "$T/r.wav" -af dynaudnorm "$T/a.wav" || cp "$T/r.wav" "$T/a.wav"
[ -s "$T/a.wav" ] || fail "pas de son dans cette vidéo"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$T/a.wav" | cut -d. -f1)
# passages de parole : tout ce qui dépasse le seuil pendant au moins 0,8 s (repéré sur le son d'origine, avant mise à niveau)
ffmpeg -v info -i "$T/r.wav" -af "silencedetect=noise=${TH_DB}dB:d=0.8" -f null - 2> "$T/sil.txt"
python3 - "$T/sil.txt" "${DUR:-600}" > "$T/parts.txt" <<'PY'
import re, sys
txt = open(sys.argv[1]).read(); dur = float(sys.argv[2] or 600)
st = [float(x) for x in re.findall(r'silence_start: ([0-9.]+)', txt)]
en = [float(x) for x in re.findall(r'silence_end: ([0-9.]+)', txt)]
# zones de son = entre la fin d'un silence et le début du suivant
edges, t = [], 0.0
for i, s in enumerate(st):
    if s - t > 0.5: edges.append([t, s])
    t = en[i] if i < len(en) else dur
if dur - t > 0.5: edges.append([t, dur])
# marges et regroupement des zones proches (moins de 1,5 s d'écart), au plus 30 s par morceau
out = []
for a, b in edges:
    a, b = max(0, a - 0.4), min(dur, b + 0.4)
    if out and a - out[-1][1] < 1.5 and b - out[-1][0] <= 30: out[-1][1] = b
    else: out.append([a, b])
for a, b in out:
    while b - a > 30: print('%.2f %.2f' % (a, a + 30)); a += 30
    if b - a >= 0.8: print('%.2f %.2f' % (a, b))
PY
N=$(wc -l < "$T/parts.txt"); I=0
while read -r A B; do
  I=$((I + 1)); step transcription $I $N
  # -nostdin et < /dev/null : sinon ffmpeg et whisper « mangent » la liste des passages lue par la boucle
  rm -f "$T/p.json"
  ffmpeg -nostdin -v error -y -ss "$A" -to "$B" -i "$T/a.wav" -ac 1 -ar 16000 "$T/p.wav" < /dev/null || continue
  # un second essai si Whisper a été interrompu (mémoire)
  nice -n 15 "$BIN" -m "$MODEL" -l fr -t "$TH" -nt -np -f "$T/p.wav" -oj -of "$T/p" < /dev/null >/dev/null 2>&1 ||
    nice -n 15 "$BIN" -m "$MODEL" -l fr -t "$TH" -nt -np -f "$T/p.wav" -oj -of "$T/p" < /dev/null >/dev/null 2>&1 || continue
  python3 - "$T/p.json" "$A" >> "$T/lines.txt" <<'PY'
import json, sys
try: d = json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
a = float(sys.argv[2])
for s in d.get('transcription', []):
    t = (s.get('text') or '').strip()
    # phrases parasites fréquentes sur du bruit (Whisper « invente » parfois ces formules)
    import re
    # bruits notés par Whisper : (...), (Rires), *Propos indistincts*, [Musique], <i>…</i>
    t = re.sub(r'\([^)]*\)|\*[^*]*\*|\[[^\]]*\]|</?i>', ' ', t)
    t = re.sub(r'\s+', ' ', t).strip(' -')
    if not t or not re.search(r'[A-Za-zÀ-ÿ]{2}', t): continue
    if re.search(r'amara|sous-titr|merci d.avoir regard|abonnez-vous', t, re.I): continue
    # formules que Whisper invente sur un bruit de fond, seules sur la ligne
    if re.fullmatch(r"(merci( beaucoup)?|je vous souhaite une bonne soirée|au revoir|à bientôt)[ .!,]*", t, re.I): continue
    # même phrase répétée en boucle : gardée une seule fois
    ph, seen = [], set()
    for x in re.split(r'(?<=[.!?])\s+', t):
        k = x.strip().lower()
        if k and k not in seen: seen.add(k); ph.append(x.strip())
    t = ' '.join(ph)
    print(json.dumps({'t': round(a + s['offsets']['from'] / 1000, 1), 'text': t}, ensure_ascii=False))
PY
done < "$T/parts.txt"
python3 - "$T/lines.txt" "$OUT" <<'PY'
import json, sys, time
lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
json.dump({'state': 'ready', 'v': 2, 'at': int(time.time()), 'lines': lines}, open(sys.argv[2] + '.tmp', 'w'), ensure_ascii=False)
PY
mv -f "$OUT.tmp" "$OUT"
