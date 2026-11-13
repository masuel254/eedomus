# Maison : instructions pour Claude

## Qui tu aides
- Le propriétaire parle **français** et n'est **pas développeur**. Explique très simplement, étape par étape, sans jargon.
- Il veut que **Claude fasse tout le travail** : modifier, tester, publier. Ne lui demande pas de taper des commandes.

## Le projet
- **Appli web (PWA)** dans `docs/`, publiée par GitHub Pages à chaque `git push` sur `main` :
  - `docs/app.js` : toute l'appli, en JavaScript ES5 sans outil de build ;
  - `docs/app.css`, `docs/config.json` (pièces, appareils, palette des lampes), `docs/sw.js` (service worker, notifications), `docs/changelog.json`.
- **Serveur** : un workflow n8n sur un VPS OVH (l'adresse est `api` dans `docs/config.json`). Son code est écrit dans `scripts/deploy-n8n.mjs` (gros gabarit de texte), et on le met en ligne avec `node scripts/deploy-n8n.mjs`.
  - Dans le code n8n du gabarit, pas de backtick, pas de `${`, pas de `\n` : écris `[0-9]` au lieu de `\d`, et n'utilise ni `URL()` ni le module `crypto` (crypto en JS pur, voir `scripts/webpush-lib.js`).
  - Le serveur relie eedomus, Netatmo (chauffage et caméras), Imou, Tuya (sauna, PAC), iAquaLink (piscine), Quandify (eau), le Web Push et les coûts d'énergie.
  - Une minuterie tourne toutes les 30 s (alertes garage, fuite d'eau, chauffage sur présence). Les données statiques n8n (`SD`) peuvent être écrasées quand deux exécutions se chevauchent : l'appli renvoie donc les réglages importants.

## Règles à suivre à chaque fois
1. **Chaque publication a un nouveau numéro de version**, avec la date et l'heure :
   `node scripts/bump.mjs <version> "<titre>" "<changement 1>" "<changement 2>"`
   Les changements sont des phrases simples, en français. Réglages affiche les 3 dernières versions, et les mises à jour s'installent toutes seules.
2. **Avant chaque `git push`**, après le `git add` : `node scripts/check-public.mjs`. Si elle répond **STOP**, ne publie pas : enlève le secret ou la donnée personnelle signalés.
3. **Le dépôt est public.** On n'y met jamais de secret, de mot de passe, de prénom de la famille, d'adresse ni de référence client.
   - Les prénoms viennent du serveur (variable `PEOPLE_NAMES`) et s'affichent sur l'iPhone sans être écrits dans les fichiers.
   - Les secrets sont dans `.env` sur le PC, ou dans les variables d'environnement de la session cloud. Ne les affiche jamais.
4. **Chargements rapides, toujours** :
   - mettre en cache côté serveur ;
   - ne lire que ce qui est nouveau ;
   - garder le dernier état sur l'iPhone (`localStorage`) et l'afficher tout de suite, puis le mettre à jour en arrière-plan.
5. **Ne pilote jamais un vrai appareil pendant un test** (chauffage, portail, garage, alarme, lumières, sauna) sans l'accord du propriétaire.
6. Commits en français, du type `vX.Y.Z : résumé`. Ensuite, explique au propriétaire ce qui a changé et comment le voir : fermer puis rouvrir l'appli.

## Ce qui ne marche que sur le PC
- Le dossier `private/` (captures d'écran, récupération des factures TotalEnergies et EDF avec Chrome, notes) n'est pas sur GitHub.
- Dans le cloud, on ne peut pas faire de capture d'écran de l'appli avec Chrome. Vérifie au minimum la syntaxe avec `node -e "new Function(require('fs').readFileSync('docs/app.js','utf8'))"`.
