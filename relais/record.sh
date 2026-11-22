#!/bin/bash
# Enregistre en continu le flux secondaire (basse définition) d'une caméra Imou, en morceaux de 10 min,
# sans réencodage de l'image. Lancé par systemd (relais-cam@<caméra>.service), qui le relance s'il s'arrête.
# Caméras en Wi-Fi faible : on leur laisse le temps de répondre. Si une caméra reste muette 3 fois de suite,
# on la cherche sur le réseau (même code, autre adresse).
DIR="$1"
CONF=/etc/relais/cameras.conf
STATE=/var/lib/relais; mkdir -p $STATE
. /etc/relais/relais.env
LINE=$(awk -F'|' -v d="$DIR" '{ id=$1; gsub(/[^A-Za-z0-9_-]/, "_", id); if (id == d) print }' "$CONF")
[ -z "$LINE" ] && { echo "Caméra $DIR absente de $CONF"; sleep 60; exit 1; }
URL=$(echo "$LINE" | cut -d'|' -f3)
OUT="$REC_DIR/$DIR"
mkdir -p "$OUT"
FAILS=$(cat $STATE/fail-$DIR 2>/dev/null || echo 0)

probe() { timeout 50 ffprobe -v error -rtsp_transport tcp -timeout 20000000 -analyzeduration 10000000 -probesize 5000000 \
  -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$1" 2>/dev/null | head -n1; }

CODEC=$(probe "$URL")
if [ -z "$CODEC" ] && [ "$FAILS" -ge 2 ]; then
  # muette plusieurs fois : adresse changée ? on cherche une caméra qui accepte ce même code
  IP=$(echo "$URL" | sed -E 's#^rtsp://[^@]*@([^:/]+).*#\1#')
  NET=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | cut -d. -f1-3)
  CANDS=$(for i in $(seq 2 253); do ( timeout 2 bash -c "exec 3<>/dev/tcp/$NET.$i/554" 2>/dev/null && echo "$NET.$i" ) & done; wait)
  for C in $CANDS; do
    [ "$C" = "$IP" ] && continue
    NEW=$(echo "$URL" | sed -E "s#@[^:/]+#@$C#")
    CODEC=$(probe "$NEW")
    if [ -n "$CODEC" ]; then
      URL="$NEW"
      awk -F'|' -v d="$DIR" -v u="$URL" 'BEGIN{OFS="|"} { id=$1; gsub(/[^A-Za-z0-9_-]/, "_", id); if (id == d) $3=u; print }' "$CONF" > "$CONF.tmp" && cat "$CONF.tmp" > "$CONF" && rm -f "$CONF.tmp"
      echo "Caméra $DIR retrouvée à l'adresse $C"
      break
    fi
  done
fi
if [ -z "$CODEC" ]; then
  echo $((FAILS + 1)) > $STATE/fail-$DIR
  echo "Caméra $DIR injoignable (essai $((FAILS + 1))), nouvel essai dans 30 s"; sleep 30; exit 1
fi
echo 0 > $STATE/fail-$DIR

TAG=""
[ "$CODEC" = "hevc" ] && TAG="-tag:v hvc1"   # pour que l'iPhone lise le H.265
# son converti en AAC (le G.711 des caméras n'est pas lu par l'iPhone) ; si le son fait échouer l'enregistrement, on s'en passe
AUDIO="-map 0:a:0? -c:a aac -b:a 32k -ar 16000"
[ -f $STATE/noaudio-$DIR ] && AUDIO="-an"
T0=$(date +%s)
set -f   # « 0:a:0? » ne doit pas être pris pour un nom de fichier
ffmpeg -hide_banner -loglevel error -nostdin \
  -rtsp_transport tcp -timeout 20000000 -analyzeduration 10000000 -probesize 5000000 -fflags +genpts -i "$URL" \
  -map 0:v:0 -c:v copy $TAG $AUDIO \
  -f segment -segment_time 600 -segment_atclocktime 1 -reset_timestamps 1 -strftime 1 \
  -segment_format mp4 -segment_format_options movflags=+faststart \
  "$OUT/%Y%m%d-%H%M%S.mp4"
RC=$?
# arrêt dans la première minute : si ça se répète avec le son, on enregistre sans le son
if [ $(( $(date +%s) - T0 )) -lt 60 ] && [ "$AUDIO" != "-an" ]; then
  N=$(( $(cat $STATE/short-$DIR 2>/dev/null || echo 0) + 1 )); echo $N > $STATE/short-$DIR
  [ $N -ge 3 ] && touch $STATE/noaudio-$DIR && echo "Caméra $DIR : enregistrement sans le son"
else echo 0 > $STATE/short-$DIR; fi
exit $RC
