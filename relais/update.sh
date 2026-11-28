#!/bin/bash
# Mise à jour automatique du relais (toutes les 15 min avec le nettoyage) : si une nouvelle version du programme
# est publiée sur GitHub, on la vérifie puis on l'installe et on relance ce qui doit l'être.
SRC=https://raw.githubusercontent.com/masuel254/eedomus/main/relais
OPT=/opt/relais
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
for f in relais.js record.sh update.sh detect.py transcribe.sh; do curl -fsSL --max-time 30 "$SRC/$f" -o "$T/$f" && [ -s "$T/$f" ] || exit 0; done
node --check "$T/relais.js" && bash -n "$T/record.sh" && bash -n "$T/update.sh" || { echo "Mise à jour ignorée : fichier invalide"; exit 0; }
# police pour légender le résumé vidéo (caméra, heure)
[ -f /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf ] || DEBIAN_FRONTEND=noninteractive timeout 600 apt-get install -y -qq fonts-dejavu-core >/dev/null 2>&1
# reconnaissance des personnes pour le résumé (OpenCV de Debian + petit modèle MobileNet-SSD, 23 Mo)
python3 -c 'import cv2' 2>/dev/null || DEBIAN_FRONTEND=noninteractive timeout 900 apt-get install -y -qq python3-opencv >/dev/null 2>&1
M=$OPT/models; mkdir -p $M
for f in deploy.prototxt mobilenet_iter_73000.caffemodel; do
  [ -s $M/$f ] || curl -fsSL --max-time 300 "https://raw.githubusercontent.com/chuanqi305/MobileNet-SSD/master/$f" -o $M/$f.tmp && mv -f $M/$f.tmp $M/$f 2>/dev/null
done
# tâche des 15 min : chaque étape a un temps maximum, et le signal au serveur part même si le nettoyage échoue
D=/etc/systemd/system/relais-clean.service.d; F=$D/limites.conf
W="[Service]
TimeoutStartSec=25min
ExecStart=
ExecStart=-/usr/bin/timeout 600 /usr/bin/node $OPT/relais.js clean
ExecStart=-/usr/bin/timeout 120 /usr/bin/node $OPT/relais.js hello
ExecStart=-/usr/bin/timeout 900 $OPT/update.sh"
if [ "$(cat $F 2>/dev/null)" != "$W" ]; then mkdir -p $D; printf '%s\n' "$W" > $F; systemctl daemon-reload; fi
# journal gardé après un redémarrage (pour comprendre un blocage)
[ -d /var/log/journal ] || { mkdir -p /var/log/journal; systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1; systemctl restart systemd-journald; }
cmp -s "$T/transcribe.sh" $OPT/transcribe.sh || install -m 755 "$T/transcribe.sh" $OPT/transcribe.sh
# reconnaissance vocale (whisper.cpp, compilé ici une seule fois, en tâche de fond : 10 à 20 min) et modèle « small » compressé (190 Mo)
WH=$OPT/whisper
# mémoire de secours (swap) de 2 Go, toujours active (même après un redémarrage) : la VM n'a qu'1 Go et Whisper en prend 500 Mo
[ -f /var/swap-relais ] || { fallocate -l 2G /var/swap-relais 2>/dev/null || dd if=/dev/zero of=/var/swap-relais bs=1M count=2048 status=none; chmod 600 /var/swap-relais; mkswap /var/swap-relais >/dev/null; }
grep -q /var/swap-relais /etc/fstab || echo '/var/swap-relais none swap sw 0 0' >> /etc/fstab
swapon --show=NAME --noheadings | grep -q /var/swap-relais || swapon /var/swap-relais
if [ ! -x $WH/whisper-cli ] && ! systemctl is-active --quiet relais-whisper-build 2>/dev/null && [ ! -f $WH/.echec ]; then
  mkdir -p $WH
  # la VM n'a qu'1 Go de mémoire : mémoire de secours (swap) de 2 Go, compilation sur un seul cœur, priorité minimale,
  # mémoire du compilateur plafonnée (la VM reste disponible pour les vidéos pendant ce temps)
  systemd-run --quiet --collect --unit relais-whisper-build -p Nice=19 -p IOSchedulingClass=idle -p MemoryMax=600M -p CPUQuota=60% /bin/bash -c "
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential cmake git >/dev/null 2>&1
    rm -rf $WH/src && git clone -q --depth 1 -b v1.7.4 https://github.com/ggml-org/whisper.cpp $WH/src &&
    cd $WH/src && cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DBUILD_SHARED_LIBS=OFF >/dev/null &&
    cmake --build build -j1 --target whisper-cli >/dev/null && install -m 755 build/bin/whisper-cli $WH/whisper-cli && rm -rf $WH/src || touch $WH/.echec"
fi
[ -s $WH/ggml-small-q5_1.bin ] || { mkdir -p $WH; curl -fsSL --max-time 900 https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin -o $WH/m.tmp && mv -f $WH/m.tmp $WH/ggml-small-q5_1.bin; }
cmp -s "$T/detect.py" $OPT/detect.py || install -m 755 "$T/detect.py" $OPT/detect.py
WEB=0; CAM=0
cmp -s "$T/relais.js" $OPT/relais.js || { install -m 644 "$T/relais.js" $OPT/relais.js; WEB=1; }
cmp -s "$T/record.sh" $OPT/record.sh || { install -m 755 "$T/record.sh" $OPT/record.sh; CAM=1; }
cmp -s "$T/update.sh" $OPT/update.sh || install -m 755 "$T/update.sh" $OPT/update.sh
[ $WEB = 1 ] && systemctl restart relais-web.service && echo "Relais mis à jour"
if [ $CAM = 1 ]; then
  for u in $(systemctl list-units --plain --no-legend 'relais-cam@*' | awk '{print $1}'); do systemctl restart "$u"; done
  echo "Enregistrement mis à jour"
fi
exit 0
