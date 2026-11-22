#!/bin/bash
# Enregistre en continu le flux secondaire (basse définition) d'une caméra Imou, en morceaux de 10 min,
# sans réencodage de l'image. Lancé par systemd (relais-cam@<caméra>.service), qui le relance s'il s'arrête.
# Si la caméra a changé d'adresse sur le réseau, on la retrouve toute seule (même code, autre adresse).
DIR="$1"
CONF=/etc/relais/cameras.conf
. /etc/relais/relais.env
LINE=$(awk -F'|' -v d="$DIR" '{ id=$1; gsub(/[^A-Za-z0-9_-]/, "_", id); if (id == d) print }' "$CONF")
[ -z "$LINE" ] && { echo "Caméra $DIR absente de $CONF"; sleep 60; exit 1; }
URL=$(echo "$LINE" | cut -d'|' -f3)
OUT="$REC_DIR/$DIR"
mkdir -p "$OUT"

probe() { timeout 20 ffprobe -v error -rtsp_transport tcp -timeout 8000000 -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$1" 2>/dev/null | head -n1; }

CODEC=$(probe "$URL")
if [ -z "$CODEC" ]; then
  # adresse changée ? on cherche sur le réseau local une caméra qui accepte ce même code
  IP=$(echo "$URL" | sed -E 's#^rtsp://[^@]*@([^:/]+).*#\1#')
  NET=$(echo "$IP" | cut -d. -f1-3)
  for i in $(seq 2 254); do
    C="$NET.$i"; [ "$C" = "$IP" ] && continue
    timeout 0.3 bash -c "exec 3<>/dev/tcp/$C/554" 2>/dev/null || continue
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
[ -z "$CODEC" ] && { echo "Caméra $DIR injoignable, nouvel essai dans 1 min"; sleep 60; exit 1; }

TAG=""
[ "$CODEC" = "hevc" ] && TAG="-tag:v hvc1"   # pour que l'iPhone lise le H.265
# son : converti en AAC (le G.711 des caméras n'est pas lu par l'iPhone), image copiée telle quelle
exec ffmpeg -hide_banner -loglevel error -nostdin \
  -rtsp_transport tcp -timeout 10000000 -fflags +genpts -i "$URL" \
  -map 0:v:0 -map '0:a:0?' -c:v copy $TAG -c:a aac -b:a 32k -ar 16000 \
  -f segment -segment_time 600 -segment_atclocktime 1 -reset_timestamps 1 -strftime 1 \
  -segment_format mp4 -segment_format_options movflags=+faststart \
  "$OUT/%Y%m%d-%H%M%S.mp4"
