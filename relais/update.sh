#!/bin/bash
# Mise à jour automatique du relais (toutes les 15 min avec le nettoyage) : si une nouvelle version du programme
# est publiée sur GitHub, on la vérifie puis on l'installe et on relance ce qui doit l'être.
SRC=https://raw.githubusercontent.com/masuel254/eedomus/main/relais
OPT=/opt/relais
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
for f in relais.js record.sh update.sh; do curl -fsSL --max-time 30 "$SRC/$f" -o "$T/$f" && [ -s "$T/$f" ] || exit 0; done
node --check "$T/relais.js" && bash -n "$T/record.sh" && bash -n "$T/update.sh" || { echo "Mise à jour ignorée : fichier invalide"; exit 0; }
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
