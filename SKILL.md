# Git & Collaboration — A26K Jarvis Platform

Ce document définit les pratiques Git, les conventions de code, et le workflow de collaboration pour les dépôts Jarvis Calendar et Jarvis SEO.

---

## 1. Dépôts

| Repo | Stack | Deploy | URL |
|------|-------|--------|-----|
| `Jarvis-Calendar` | React JSX + Supabase + Vercel | Vercel (auto on push main) | jarvis-calendar.vercel.app |
| `Jarvis-SEO` | Node.js + Anthropic API + Sanity | GitHub Actions | Déclenché par jarvis_tasks |

Les deux repos partagent la même base Supabase (PostgreSQL, Auth, RLS, Storage, Realtime, Edge Functions).

---

## 2. Branches

### 2.1. Branche principale

`main` est la seule branche permanente. Elle est toujours déployable.

- Jarvis Calendar : chaque push sur `main` déclenche un deploy Vercel automatique.
- Jarvis SEO : chaque push sur `main` met à jour le code exécuté par GitHub Actions.
- **Ne jamais développer directement sur `main`** (sauf hotfix critique < 5 lignes par le fondateur).

### 2.2. Nommage des branches

```
feature/<scope>-<nom-court>    # Nouvelle fonctionnalité
fix/<scope>-<nom-court>        # Correction de bug
chore/<scope>-<nom-court>      # Refacto, tooling, CI, docs
security/<scope>-<nom-court>   # Fix de sécurité, RLS, RBAC
migration/<nom-court>          # Migration SQL Supabase
```

**Scopes principaux :**

| Scope | Périmètre |
|-------|-----------|
| `webapp` | React frontend (calendrier, publications, SlidePanel, dashboard, users) |
| `api` | Edge Functions Supabase (admin-auth, admin-users, email-service, trigger-generation) |
| `db` | Schema SQL, migrations, RLS policies, triggers |
| `seo` | Pipeline Jarvis SEO (articles, exhibits, publishing) |
| `infra` | Vercel config, GitHub Actions, Supabase config, secrets |

**Exemples :**
```
feature/webapp-kanban-view
fix/api-reset-password-401
chore/webapp-extract-shared-components
security/db-rls-admin-actions
migration/add-admin-actions-log
```

**Règles :**
- Anglais, minuscule, tirets, pas d'accents ni d'espaces.
- 1 sujet par branche — pas de fourre-tout.
- Supprimer la branche après merge.

### 2.3. Workflow de création

```bash
git checkout main
git pull origin main
git checkout -b feature/<scope>-<nom-court>
# ... développer, committer ...
git push -u origin feature/<scope>-<nom-court>
# → Ouvrir une PR vers main
```

---

## 3. Commits

### 3.1. Format

```
<type>(<scope>): <résumé impératif en anglais>

[optionnel] Description détaillée
[optionnel] Refs: #issue, JIRA-123
```

**Types :**

| Type | Usage |
|------|-------|
| `feat` | Nouvelle fonctionnalité |
| `fix` | Correction de bug |
| `refactor` | Refactorisation sans changement fonctionnel |
| `chore` | Tooling, CI, config |
| `docs` | Documentation (CLAUDE.md, README, SECURITY.md) |
| `test` | Tests |
| `security` | Fix de sécurité, RLS, RBAC |
| `migration` | Migration SQL |

**Bons exemples :**
```
feat(webapp): add Kanban pipeline view with drag & drop
fix(api): reset password 401 — deploy with --no-verify-jwt
refactor(webapp): extract Badge, timeAgo, Toast into shared-components.jsx
security(db): add RLS on admin_actions_log for super_admin only
migration: add admin_actions_log table with indexes
docs: update CLAUDE.md with SlidePanel, exhibits, corbeille
```

**Mauvais exemples :**
```
update code                     # trop vague
fix stuff                       # aucun contexte
WIP                             # ne pas committer du WIP sur main
feat: ajouté le kanban          # français dans le message
```

### 3.2. Règles

- Commits **petits et cohérents** — un changement logique par commit.
- Le code **doit compiler** (`npm run build` passe) avant le commit.
- Ne jamais committer de secrets, clés API, tokens, ou fichiers `.env`.
- Ne jamais committer `node_modules/`, `dist/`, ou `secrets/`.

---

## 4. Pull Requests (PR)

### 4.1. Quand ouvrir une PR

- Dès qu'un périmètre fonctionnel est testable.
- Pour les gros sujets : ouvrir en **Draft** pour feedback précoce.

### 4.2. Template de PR

```markdown
## Contexte
[Quel problème / besoin business]

## Changements
- [Liste courte des modifications principales]

## Impact
- [ ] Migration SQL nécessaire
- [ ] Edge Function à redéployer
- [ ] Secrets à configurer
- [ ] Breaking change

## Tests effectués
- [ ] Build OK (`npm run build`)
- [ ] Test manuel dans l'app
- [ ] Edge Functions testées (curl ou app)
- [ ] Vérifications grep (comptage occurrences)

## Screenshots
[Si changement visuel]
```

### 4.3. Règles de merge

- **Jamais de merge direct sur main sans PR** (sauf hotfix critique).
- **1 review minimum** (CTO pour sécurité, compliance, architecture).
- Avant merge :
  - Rebase sur main si la branche est en retard.
  - Build passe.
  - Pas de conflits.
- **Stratégie : Squash and merge** (un commit propre par PR).

---

## 5. Architecture des fichiers — Jarvis Calendar

```
webapp/
├── calendrier-publication.jsx  # App shell, sidebar, header, CalendarView, PubModal, CommandPalette
├── dashboard.jsx               # Dashboard (stats, GEO moyen par site, volume hebdo)
├── publications-list.jsx       # Page Publications (liste, filtres, tri, batch actions)
├── slide-panel.jsx             # SlidePanel (brief, contenu, hero, infographies, GEO score, workflow)
├── geo-score.jsx               # computeGEOScore + ScoreBar
├── kanban-view.jsx             # Pipeline Kanban (drag & drop)
├── users-management.jsx        # Gestion utilisateurs (CRUD, invitation, historique)
├── profile-settings.jsx        # Page Mon compte
├── audit-log.jsx               # Historique des actions admin (super_admin only)
├── shared-components.jsx       # Badge, timeAgo, ConfirmModal, Toast
├── auth-api.js                 # Client unifié admin-auth + admin-users
├── theme.js                    # Design tokens (T, ST, SITE_COLORS, inp, btP, btG, mono)
├── supabase.js                 # Client Supabase (anon key)
└── src/index.css               # Tailwind v4 + CSS vars + keyframes

supabase/functions/
├── admin-auth/                 # Password reset, set password, change email, force signout
├── admin-users/                # Invite, resend, delete, activate, deactivate
├── email-service/              # Envoi d'emails centralisé via Resend (templates HTML)
├── _shared/admin-helpers.ts    # Auth, RBAC, audit log, sendEmail, rate limiting
├── trigger-generation/         # Déclenche GitHub Actions pour Jarvis SEO
├── schedule-publication/       # Database webhook handler
├── generate-brief/             # Génération de brief éditorial via Claude
└── article-content/            # Bridge Sanity pour l'édition d'articles
```

### Convention : pas de TypeScript dans la webapp

La webapp utilise **React JSX pur** (pas de TypeScript, pas de PropTypes). Les Edge Functions Supabase sont en **TypeScript** (contrainte Deno).

### Convention : styles inline

La webapp utilise des **styles inline** via les tokens de `theme.js` (T, ST, inp, btP, btG). Pas de CSS modules, pas de styled-components. Les seules classes CSS sont dans `index.css` (Tailwind v4 + keyframes).

### Convention : composants partagés

Tout composant utilisé dans 2+ fichiers va dans `shared-components.jsx`. Ne pas dupliquer Badge, timeAgo, Toast, ConfirmModal.

---

## 6. Architecture des fichiers — Jarvis SEO

```
scripts/
├── seo-publish-article.js      # Pipeline principal (--draft-only ou --publish)
├── seo-exhibits.js             # Génération d'infographies PNG
├── seo-orchestrator.js         # Orchestrateur multi-sites
├── seo-images.js               # Génération d'images (hero, OG)
├── seo-shared.js               # Utilitaires partagés
├── calendar-connector.js       # Adapter Supabase (upload exhibits, update publications)
├── workflow-single-task.js     # Handler pour jarvis_tasks individuelles
├── workflow-daily.js           # Workflow quotidien automatique
└── seo-weekly-report.js        # Rapport hebdomadaire
```

---

## 7. Supabase — Migrations SQL

### Nommage

```
supabase/migrations/NNN_<description>.sql
```

Numérotation séquentielle : `001`, `002`, ..., `023`.

### Règles

- Chaque migration est **idempotente** quand possible (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE`).
- Toujours inclure les **policies RLS** dans la même migration que la table.
- Toujours ajouter des **index** pour les colonnes filtrées fréquemment.
- **Tester localement** avant `supabase db push`.
- Documenter les contraintes CHECK ajoutées (enum d'actions, etc.).

### Déploiement

```bash
supabase db push                                    # Appliquer les migrations
supabase functions deploy <nom> --no-verify-jwt     # Déployer une Edge Function
supabase secrets set KEY=VALUE                      # Configurer un secret
```

**Important : `--no-verify-jwt`** pour les Edge Functions qui vérifient le JWT elles-mêmes (admin-auth, admin-users, email-service). Sans ce flag, le gateway Supabase vérifie le JWT en double et rejette avec 401.

---

## 8. Edge Functions — Conventions

### Authentification

- Les fonctions appelées par la webapp utilisent `authenticateAdmin()` de `_shared/admin-helpers.ts`.
- `email-service` utilise un secret interne (`x-internal-secret`) — jamais appelé directement par la webapp.

### Gestion d'erreur

Toujours retourner des erreurs structurées :
```json
{ "error": { "code": "USER_NOT_FOUND", "message": "User not found" } }
```

Le client `auth-api.js` mappe les codes vers des messages français.

### Audit

Toute action admin est loggée dans `admin_actions_log` via `auditLog()`.

---

## 9. Secrets & Sécurité

### Secrets Supabase (Edge Functions)

| Secret | Usage |
|--------|-------|
| `SUPABASE_URL` | Auto-injecté |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injecté |
| `SUPABASE_ANON_KEY` | Auto-injecté |
| `ALLOWED_ORIGIN` | CORS : `https://jarvis-calendar.vercel.app` |
| `RESEND_API_KEY` | Envoi d'emails via Resend |
| `RESEND_FROM_DOMAIN` | `a26k.ch` |
| `INTERNAL_FUNCTION_SECRET` | Auth inter-fonctions (email-service) |
| `GITHUB_PAT` | Déclencher GitHub Actions (trigger-generation) |

### GitHub Secrets (Jarvis-SEO)

| Secret | Usage |
|--------|-------|
| `SUPABASE_URL` | Connexion Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Client service_role |
| `ANTHROPIC_API_KEY` | API Claude pour génération d'articles |
| `SANITY_PROJECT_ID` | Publication sur Sanity CMS |
| `SANITY_TOKEN` | Auth Sanity |
| `RESEND_API_KEY` | Notifications email |

### Règles

- **Ne jamais committer de secrets** dans le code source.
- Les secrets sont dans `.env` (local, gitignored) ou dans Supabase/GitHub Secrets.
- Rotation régulière des clés API (minimum annuelle).

---

## 10. Workflow de test

### Avant chaque PR

```bash
# Jarvis Calendar
cd webapp && npm run build    # Build doit passer sans erreur

# Vérifications grep (exemples)
grep -c "searchTerm" webapp/file.jsx   # Compter les occurrences
grep "import.*from" webapp/file.jsx    # Vérifier les imports
```

### Tests manuels requis

| Zone | Quoi tester |
|------|-------------|
| Auth | Login, logout, session expirée, invitation, set password |
| RBAC | Actions admin cachées pour les members |
| Publications | Créer, éditer, supprimer, archiver, restaurer |
| Jarvis SEO | Générer brouillon, infographie, publier site |
| Email | Reset password, invitation, notifications |
| Realtime | Changements reflétés en live dans le SlidePanel |

### Tests Jarvis SEO

```bash
cd Jarvis-SEO && node tests/test-all.js
```

---

## 11. RBAC — Matrice des permissions

| Action | super_admin | admin | member |
|--------|-------------|-------|--------|
| Voir publications (ses sites) | ✓ | ✓ | ✓ |
| Voir publications (tous sites) | ✓ | ✗ | ✗ |
| Créer publication | ✓ | ✓ | ✓ (draft uniquement) |
| Modifier publication | ✓ | ✓ | ✓ (ses sites) |
| Supprimer publication | ✓ | ✓ | ✗ |
| Générer avec Jarvis | ✓ | ✓ | ✗ |
| Publier sur Sanity | ✓ | ✓ | ✗ |
| Gérer utilisateurs | ✓ | ✗ | ✗ |
| Voir audit log | ✓ | ✗ | ✗ |
| Configurer sites | ✓ | ✗ | ✗ |

---

## 12. Rôles & responsabilités

### Fondateur (JB P — super_admin)

- Décisions produit et architecture.
- Peut proposer du code via Claude Code, toujours via PR.
- Valide les déploiements en production.

### CTO (quand recruté)

- Valide les décisions d'architecture, sécurité, performance.
- Droit de veto sur les PR hors-standard.
- Responsable CI/CD, monitoring, alerting.

### Développeurs

- Utilisent le workflow branche → PR → review → merge.
- Respectent les conventions de commit et de code.
- Documentent les changements dans CLAUDE.md si nécessaire.

### Claude Code (IA)

- Génère du code dans des branches dédiées, jamais sur main.
- Le code doit compiler et respecter les patterns existants.
- Chaque génération importante inclut un résumé des changements.
- Décision finale de merge = humain.

---

## 13. Les 9 sites A26K

| Slug | Nom | Short | Couleur |
|------|-----|-------|---------|
| fg | Fiduciaire Genevoise | FG | Bleu |
| fv | Fiduciaire Vaudoise | FV | Bleu |
| ag | Assurance Genevoise | AG | Orange |
| rg | Relocation Genevoise | RG | Bleu |
| mc | Medcourtage | MC | Vert |
| am | Automotoplus | AM | Orange |
| gl | Golamal | GL | Rouge |
| pf | Prepafa | PF | Vert |
| ig | Immobilière Genevoise | IG | Rose |

Chaque site a son `sanity_document_type` dans la table `websites` et son `config.json` dans Jarvis-SEO.

---

## 14. Évolution future

### Court terme
- Ajouter des tests unitaires (Vitest pour la webapp, Jest pour Jarvis SEO).
- Ajouter un linter (ESLint + Prettier) avec pre-commit hook.
- CI GitHub Actions : build + lint + test sur chaque PR.

### Moyen terme
- Branche `develop` pour staging avant production.
- Branches `release/x.y.z` pour les versions.
- Monitoring (Sentry pour les erreurs frontend, Supabase logs pour le backend).
- Rate limiting avancé (Redis au lieu de in-memory).

### Long terme
- Tests end-to-end (Playwright).
- Déploiement multi-environnement (staging, production).
- Documentation API (OpenAPI/Swagger pour les Edge Functions).
