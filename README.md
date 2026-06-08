# Madame Fafi 🔮

Plateforme de voyance interactive.

## Structure
```
server.js          ← serveur Node.js complet (tout-en-un)
package.json       ← dépendances
render.yaml        ← config déploiement Render
public/            ← frontend (HTML/CSS/assets)
migrations/        ← schéma base de données SQL
```

## Variables d'environnement (Render)
- `DATABASE_URL`         — connexion Neon PostgreSQL
- `JWT_SECRET`           — clé secrète JWT utilisateurs
- `ADMIN_JWT_SECRET`     — clé secrète JWT admin
- `ADMIN_PASSWORD`       — mot de passe super admin
- `STRIPE_SECRET_KEY`    — clé Stripe sk_live_...
- `STRIPE_WEBHOOK_SECRET`— secret webhook Stripe
- `APP_URL`              — https://madamefafi.fr

## Déploiement
Push sur GitHub → Render redéploie automatiquement.
