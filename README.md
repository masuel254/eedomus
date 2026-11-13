# Maison — interface eedomus + Netatmo

Application web (PWA) pour iPhone, en thème sombre, pour piloter la box eedomus
et, bientôt, les équipements Netatmo (caméra extérieure, chauffage).

## Architecture

```
iPhone (PWA, GitHub Pages : dossier docs/)
   │ HTTPS + jeton (stocké sur le téléphone, jamais dans ce dépôt)
   ▼
n8n (VPS) — workflow « Maison · API eedomus »
   ├── API eedomus (cloud : api.eedomus.com)
   └── API Netatmo (à venir)
```

- `docs/` : l'application (HTML/CSS/JS sans compilation).
- `docs/config.json` : pièces et modules affichés. Le workflow n8n n'autorise que les modules et valeurs listés ici.
- `scripts/deploy-n8n.mjs` : crée ou met à jour le workflow n8n à partir de `docs/config.json` et du fichier local `.env`.

## Secrets

Aucun secret n'est stocké dans ce dépôt. Le fichier local `.env` (ignoré par git) contient :

```
EEDOMUS_API_USER=…
EEDOMUS_API_SECRET=…
N8N_URL=…
N8N_API_KEY=…
MAISON_TOKEN=…             # jeton principal
MAISON_TOKEN_PRENOM=…      # un jeton par personne
```

## Accès de la famille

- Ajouter une personne : `node scripts/deploy-n8n.mjs --add Prénom`, puis générer son QR code.
- Couper l'accès d'une personne : supprimer sa ligne `MAISON_TOKEN_…` dans `.env`, puis `node scripts/deploy-n8n.mjs`.

## Modifier les modules

1. Éditer `docs/config.json`.
2. `node scripts/deploy-n8n.mjs` pour mettre à jour la liste blanche dans n8n.
3. Publier (`git push`).
