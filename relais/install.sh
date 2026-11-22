#!/bin/bash
# Installation du « relais caméras » dans la machine virtuelle Debian de la Freebox.
# À lancer dans la VM :  curl -fsSL https://raw.githubusercontent.com/masuel254/eedomus/main/relais/install.sh | sudo bash
# On peut le relancer sans risque : les réglages déjà faits sont gardés (touche Entrée).
set -u
SRC="https://raw.githubusercontent.com/masuel254/eedomus/main"
ETC=/etc/relais
OPT=/opt/relais
ENVF=$ETC/relais.env
B=''; G=''; R=''; N=''   # pas de couleurs : la console de Freebox OS les affiche mal
say()  { echo; echo "${B}== $* ==${N}"; }
ok()   { echo "${G}✔ $*${N}"; }
bad()  { echo "${R}✘ $*${N}"; }
ask()  { local q="$1" def="${2:-}" a; if [ -n "$def" ]; then read -r -p "$q [$def] : " a < /dev/tty; echo "${a:-$def}"; else read -r -p "$q : " a < /dev/tty; echo "$a"; fi; }
getv() { [ -f "$ENVF" ] && sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" "$ENVF" | tail -n1; }
setv() { touch "$ENVF"; chmod 600 "$ENVF"; if grep -q "^$1=" "$ENVF"; then sed -i "s#^$1=.*#$1=\"$2\"#" "$ENVF"; else echo "$1=\"$2\"" >> "$ENVF"; fi; }

[ "$(id -u)" = 0 ] || { bad "Lance ce programme avec sudo"; exit 1; }
mkdir -p $ETC $OPT

say "1/7 Logiciels (ffmpeg, Node, Caddy)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq ffmpeg nodejs caddy cifs-utils curl ca-certificates >/dev/null \
  && ok "logiciels installés" || { bad "installation impossible (internet ?)"; exit 1; }
timedatectl set-timezone Europe/Paris 2>/dev/null; ok "heure de Paris"
curl -fsSL "$SRC/relais/relais.js" -o $OPT/relais.js && curl -fsSL "$SRC/relais/record.sh" -o $OPT/record.sh && chmod +x $OPT/record.sh \
  && ok "programme du relais téléchargé" || { bad "téléchargement impossible"; exit 1; }
API=$(curl -fsSL "$SRC/docs/config.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).api))')
[ -n "$API" ] && setv API "$API"

say "2/7 Disque de la Freebox"
# disque déjà branché par la Freebox (case « Accès aux disques Freebox ») : on le réutilise tel quel
MNT=$(findmnt -rn -t cifs,9p,virtiofs -o TARGET 2>/dev/null | head -n1)
[ -z "$MNT" ] && [ -d /mnt/Freebox ] && mountpoint -q /mnt/Freebox && MNT=/mnt/Freebox
[ -z "$MNT" ] && MNT=/mnt/freebox
mkdir -p "$MNT"
if ! mountpoint -q $MNT; then
  for f in /sys/bus/virtio/drivers/9pnet_virtio/*/mount_tag; do
    [ -f "$f" ] || continue; TAG=$(tr -d '\0' < "$f")
    if mount -t 9p -o trans=virtio,version=9p2000.L,msize=262144 "$TAG" $MNT 2>/dev/null; then
      grep -q " $MNT " /etc/fstab || echo "$TAG $MNT 9p trans=virtio,version=9p2000.L,msize=262144,nofail 0 0" >> /etc/fstab; break
    fi
  done
fi
if ! mountpoint -q $MNT; then
  for TAG in $(cat /sys/bus/virtio/drivers/virtiofs/*/tag 2>/dev/null); do
    if mount -t virtiofs "$TAG" $MNT 2>/dev/null; then grep -q " $MNT " /etc/fstab || echo "$TAG $MNT virtiofs nofail 0 0" >> /etc/fstab; break; fi
  done
fi
if ! mountpoint -q $MNT; then
  echo "Le disque n'est pas partagé directement avec la VM : on passe par le partage Windows (SMB) de la Freebox."
  echo "(Freebox OS > Paramètres de la Freebox > Partages Windows : activé, avec un utilisateur et un mot de passe.)"
  U=$(ask "Utilisateur des partages Windows" "freebox"); read -r -s -p "Mot de passe des partages Windows : " P < /dev/tty; echo
  printf 'username=%s\npassword=%s\n' "$U" "$P" > $ETC/smb.cred; chmod 600 $ETC/smb.cred
  for SH in "Freebox" "Disque dur" "Disque 1"; do
    if mount -t cifs "//mafreebox.freebox.fr/$SH" $MNT -o credentials=$ETC/smb.cred,uid=0,gid=0,vers=3.0,iocharset=utf8 2>/dev/null; then
      sed -i "\# $MNT #d" /etc/fstab
      echo "//mafreebox.freebox.fr/${SH// /\\040} $MNT cifs credentials=$ETC/smb.cred,uid=0,gid=0,vers=3.0,iocharset=utf8,nofail,_netdev 0 0" >> /etc/fstab; break
    fi
  done
fi
if mountpoint -q $MNT; then
  ok "disque de la Freebox visible dans $MNT ($(df -h --output=avail $MNT | tail -1 | tr -d ' ') libres)"
  REC_DIR="$MNT/Relais cameras"
else
  bad "disque de la Freebox introuvable : enregistrements sur le disque de la VM"
  REC_DIR=/srv/relais/imou
fi
mkdir -p "$REC_DIR"; setv REC_DIR "$REC_DIR"

say "3/7 Dossier des vidéos de la Présence (FTP Netatmo)"
PD=$(getv PRESENCE_DIR)
if [ -z "$PD" ] && mountpoint -q $MNT; then
  # le dossier qui contient le plus de vidéos récentes (hors enregistrements Imou)
  PD=$(find $MNT -maxdepth 6 -type f \( -iname '*.mp4' -o -iname '*.mov' \) -mtime -30 -not -path "$REC_DIR/*" 2>/dev/null \
       | sed 's#/[^/]*$##' | sort | uniq -c | sort -rn | head -n1 | sed 's/^ *[0-9]* //')
  # remonter au dossier de la caméra si les vidéos sont rangées par date
  while [ -n "$PD" ] && basename "$PD" | grep -Eq '^[0-9_-]+$'; do PD=$(dirname "$PD"); done
fi
PD=$(ask "Dossier des vidéos de la Présence (vide si aucun)" "$PD")
setv PRESENCE_DIR "$PD"
[ -n "$PD" ] && ok "$(find "$PD" -type f \( -iname '*.mp4' -o -iname '*.mov' \) 2>/dev/null | wc -l) vidéo(s) de la Présence trouvée(s)"

say "4/7 Adresse internet du relais"
echo "C'est le nom de domaine de la Freebox (Freebox OS > Paramètres > Nom de domaine), par exemple xxxx.freeboxos.fr."
DOM=$(getv PUBLIC_URL | sed 's#^https://##')
DOM=$(ask "Nom de domaine" "$DOM" | sed 's#^https\{0,1\}://##; s#/.*##')
setv PUBLIC_URL "https://$DOM"
setv PORT 8080

say "5/7 Jumelage avec l'appli"
if [ -z "$(getv SECRET)" ] || [ "$(ask "Refaire le jumelage ? (o/n)" "n")" = "o" ]; then
  echo "Dans l'appli : Réglages > Relais caméras > « Associer le relais ». Un code à 6 chiffres s'affiche."
  until CODE=$(ask "Code affiché dans l'appli"); node $OPT/relais.js pair "$CODE"; do echo "Réessaie (le code change toutes les 15 min)."; done
fi
ok "relais jumelé"

say "6/7 Caméras Imou"
CONF=$ETC/cameras.conf
KEEP=n
[ -s $CONF ] && KEEP=$(ask "Garder les caméras déjà réglées et compléter les autres ? (o/n)" "o")
if false; then :; else
  NET=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | cut -d. -f1-3)
  echo "Recherche des caméras sur le réseau $NET.x …"
  IPS=""
  # deux passages (les caméras en Wi-Fi répondent parfois lentement), par groupes de 32 pour ménager la mémoire
  : > /tmp/relais-ips
  for T in 1.5 3; do
    for i in $(seq 2 254); do
      ( timeout $T bash -c "exec 3<>/dev/tcp/$NET.$i/554" 2>/dev/null && echo "$NET.$i" ) &
      [ $((i % 32)) = 0 ] && wait
    done >> /tmp/relais-ips; wait
  done
  IPS=$(sort -u -t. -k4 -n /tmp/relais-ips | grep -v "^$NET.254$" | tr '\n' ' ')
  echo "Appareils vidéo trouvés : ${IPS:-aucun}"
  : > $CONF.new
  [ "$KEEP" = "o" ] && cp $CONF $CONF.new
  N=$(node -e 'console.log(require("/etc/relais/imou.json").length)')
  for k in $(seq 0 $((N - 1))); do
    ID=$(node -e "console.log(require('/etc/relais/imou.json')[$k].id)"); NAME=$(node -e "console.log(require('/etc/relais/imou.json')[$k].name)")
    MODEL=$(node -e "console.log(require('/etc/relais/imou.json')[$k].model||'')")
    grep -q "^$ID|" $CONF.new && { ok "$NAME : déjà réglée"; continue; }
    echo; echo "${B}$NAME${N} ($MODEL)"
    echo "Code de sécurité : 8 caractères sur l'étiquette de la caméra (« SC »), ou le mot de passe de l'appareil si tu l'as changé."
    FOUND=""
    while [ -z "$FOUND" ]; do
      if [ -n "${LASTSC:-}" ]; then
        SC=$(ask "Code de sécurité (Entrée = le même que la caméra précédente, « - » pour ignorer cette caméra)" "$LASTSC")
        [ "$SC" = "-" ] && break
      else
        SC=$(ask "Code de sécurité (vide pour ignorer cette caméra)")
        [ -z "$SC" ] && break
      fi
      LASTSC="$SC"
      ENC=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$SC")
      for IP in $IPS; do
        U="rtsp://admin:$ENC@$IP:554/cam/realmonitor?channel=1&subtype=1"
        if timeout 15 ffprobe -v error -rtsp_transport tcp -timeout 8000000 -show_entries stream=codec_name -of csv=p=0 "$U" >/dev/null 2>&1; then FOUND="$U"; ok "trouvée à l'adresse $IP"; break; fi
      done
      if [ -z "$FOUND" ]; then
        bad "aucune caméra trouvée avec ce code"
        IP=$(ask "Adresse de la caméra si tu la connais (Freebox OS > Périphériques réseau, ex. 192.168.1.50), sinon Entrée")
        if [ -n "$IP" ]; then
          U="rtsp://admin:$ENC@$IP:554/cam/realmonitor?channel=1&subtype=1"
          if timeout 20 ffprobe -v error -rtsp_transport tcp -timeout 10000000 -show_entries stream=codec_name -of csv=p=0 "$U" >/dev/null 2>&1; then FOUND="$U"; ok "caméra jointe à l'adresse $IP"
          else bad "pas de réponse vidéo à cette adresse avec ce code (vérifie le code, ou active RTSP dans l'appli Imou)"; fi
        fi
      fi
    done
    [ -n "$FOUND" ] && echo "$ID|$NAME|$FOUND" >> $CONF.new
  done
  mv $CONF.new $CONF; chmod 600 $CONF
fi

say "Mesure du débit réel (30 s par caméra, en même temps)"
TMP=$(mktemp -d)
while IFS='|' read -r ID NAME URL; do
  [ -z "$ID" ] && continue
  ( timeout 40 ffmpeg -nostdin -loglevel error -rtsp_transport tcp -i "$URL" -t 30 -map 0:v:0 -c copy -f mp4 "$TMP/$(echo "$ID" | tr -c 'A-Za-z0-9_\n-' _).mp4" ) &
done < $CONF
wait
TOTAL=0
while IFS='|' read -r ID NAME URL; do
  [ -z "$ID" ] && continue
  F="$TMP/$(echo "$ID" | tr -c 'A-Za-z0-9_\n-' _).mp4"; S=$(stat -c %s "$F" 2>/dev/null || echo 0)
  KBPS=$((S * 8 / 30 / 1000)); TOTAL=$((TOTAL + S))
  echo "  $NAME : $KBPS kbit/s ($((S * 2880 / 1000000)) Mo par jour)"
done < $CONF
rm -rf "$TMP"
PERDAY=$((TOTAL * 2880 / 1000000000 + 1))   # Go par jour, toutes caméras
FREE=$(df -B1G --output=avail "$REC_DIR" | tail -1 | tr -d ' ')
DAYS=14
[ $((PERDAY * DAYS + 50)) -gt "$FREE" ] && DAYS=$(( (FREE - 50) / PERDAY )) && [ $DAYS -lt 1 ] && DAYS=1
echo "Total : environ $PERDAY Go par jour, soit $((PERDAY * 14)) Go pour 14 jours ; place libre : $FREE Go."
setv RETENTION_DAYS $DAYS; setv MIN_FREE_GB 30
ok "conservation : $DAYS jours"

say "7/7 Services (démarrage automatique)"
cat > /etc/systemd/system/relais-web.service <<EOF
[Unit]
Description=Relais caméras (serveur des vidéos)
After=network-online.target remote-fs.target
[Service]
Environment=TZ=Europe/Paris
ExecStart=/usr/bin/node $OPT/relais.js serve
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/relais-cam@.service <<EOF
[Unit]
Description=Relais caméras : enregistrement %i
After=network-online.target remote-fs.target
[Service]
Environment=TZ=Europe/Paris
ExecStart=$OPT/record.sh %i
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/relais-clean.service <<EOF
[Unit]
Description=Relais caméras : nettoyage et signal au serveur
[Service]
Type=oneshot
Environment=TZ=Europe/Paris
ExecStart=/usr/bin/node $OPT/relais.js clean
ExecStart=-/usr/bin/node $OPT/relais.js hello
EOF
cat > /etc/systemd/system/relais-clean.timer <<EOF
[Unit]
Description=Relais caméras : toutes les 15 min
[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
EOF
cat > /etc/caddy/Caddyfile <<EOF
# Relais caméras : HTTPS automatique (certificat Let's Encrypt), tout est transmis au relais
$DOM {
	reverse_proxy 127.0.0.1:8080
}
EOF
systemctl daemon-reload
for u in $(systemctl list-units --all --plain --no-legend 'relais-cam@*' | awk '{print $1}'); do systemctl disable --now "$u" >/dev/null 2>&1; done
systemctl enable relais-web.service relais-clean.timer >/dev/null 2>&1; systemctl restart relais-web.service; systemctl start relais-clean.timer
while IFS='|' read -r ID NAME URL; do
  [ -z "$ID" ] && continue
  systemctl enable --now "relais-cam@$(echo "$ID" | tr -c 'A-Za-z0-9_\n-' _).service" >/dev/null 2>&1
done < $CONF
systemctl restart caddy
sleep 3
curl -fsS http://127.0.0.1:8080/ping >/dev/null && ok "relais en marche" || bad "le relais ne répond pas (journalctl -u relais-web)"
node $OPT/relais.js hello || true
echo
echo "${B}Dernière étape (une seule fois) :${N} dans Freebox OS > Paramètres > Gestion des ports,"
echo "rediriger le port 443 (TCP) vers cette machine : $(hostname -I | awk '{print $1}'), port 443."
echo "Ensuite, l'appli lira les vidéos depuis la Freebox."
