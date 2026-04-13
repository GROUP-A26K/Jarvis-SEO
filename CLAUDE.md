# CLAUDE.md — Jarvis SEO v7 (A26K Publication Pipeline)

## Projet
Pipeline SEO automatise pour les sites du Groupe Genevoise (A26K, Suisse).
Gap analysis, generation d'articles, images AI, publication Sanity CMS, rapports hebdo.

**Repo** : Jarvis-SEO (prive)
**Lien Calendar** : Jarvis-Calendar (orchestration editoriale)

## Architecture
```
scripts/
  seo-shared.js              # Module central (58 exports)
  seo-gap-analysis.js        # Gap analysis SEO
  seo-publish-article.js     # Publication article → Sanity
  seo-weekly-report.js       # Rapport hebdomadaire
  seo-orchestrator.js        # Orchestrateur workflow (plan/execute/deploy/status)
  seo-images.js              # Pipeline images AI (Flux 2)
  seo-exhibits.js            # Infographies style BCG (SVG → PNG → Gemini)
  calendar-connector.js      # Adaptateur Supabase (Jarvis Calendar, filtre scheduled_at)
  workflow-daily.js           # Cron quotidien Calendar → SEO pipeline + notifications email
sites/
  config.json                # Configuration centralisee (single source of truth)
tests/
  test-all.js                # Tests unitaires
secrets/                     # .gitignore — JAMAIS commite
  semrush.json               # API key SEMrush
  supabase.json              # URL + service_role_key
  google-oauth.json          # OAuth2 credentials
  sanity.json                # Token Editor Sanity
  resend.json                # API key Resend (emails)
.github/workflows/
  jarvis-daily.yml           # Cron quotidien 5h30 UTC (= 7h30 UTC+2)
```

## Stack technique
- **Runtime** : Node.js 18+ ESM
- **CMS** : Sanity (projet ttza946i, dataset production, apiVersion 2024-01-01)
- **SEO** : SEMrush API (rate limit 8 req/s, circuit breaker)
- **AI** : Claude API (articles), Flux 2 (images), Gemini 3.1 Flash (exhibits)
- **Calendar** : Supabase (via calendar-connector.js, service_role key)
- **Images** : Sharp (traitement), BFL/Flux 2 (generation)
- **Emails** : Resend (rapports)

## Sites configures (7/9)

| Domaine | documentType Sanity | Statut |
|---------|-------------------|--------|
| fiduciaire-genevoise.ch | `fiduciaireBlogPost` | Actif (95 docs) |
| fiduciairevaudoise.ch | `fiduciaireVaudoiseBlogPost` | Actif (57 docs) |
| relocation-genevoise.ch | `relocationBlogPost` | Actif (91 docs) |
| medcourtage.ch | `medcourtageBlogPost` | Actif (50 docs) |
| automotoplus.ch | `blogPost` | Actif (121 docs) |
| immobiliere-genevoise.ch | `immobiliereBlogPost` | Actif (69 docs) |
| assurance-genevoise.ch | `assuranceGenevoiseBlogPost` | Config (documentType a verifier) |

**Non configures** : golamalch.ch, prepafa.ch (pas encore setup dans Sanity)

## Mapping Calendar ↔ SEO
Le domaine dans `websites.domain` (Supabase Calendar) doit correspondre exactement a la cle dans `sites/config.json`.
Le `sanity_document_type` dans Supabase doit correspondre a `sanity.documentType` dans config.json.

## Commandes
```bash
npm test                          # Tests unitaires
npm run gap                       # Gap analysis (tous les sites)
npm run gap -- --site medcourtage.ch
npm run publish -- --site medcourtage.ch --keyword "rc pro medecin" --dry-run
npm run plan                      # Orchestrateur : plan strategique
npm run execute                   # Orchestrateur : dry-runs + briefs
npm run deploy                    # Orchestrateur : publication Sanity
npm run status                    # Etat du pipeline
npm run images                    # Pipeline images (Flux 2)
npm run images:dry                # Images dry-run (LLM seul)
npm run report                    # Rapport hebdomadaire
npm run workflow                  # Cron quotidien Calendar → SEO
npm run exhibits:test             # Exhibit de test (SVG + PNG)
npm run exhibits:dry              # Exhibit dry-run (SVG seul)
```

## Workflow quotidien (workflow-daily.js)
1. Lit les publications du jour (status='scheduled', publish_date=today)
2. Lit les jarvis_tasks pending dont `scheduled_at <= NOW()` (ou NULL pour legacy)
3. Pour chaque publication/task, exécute `seo-publish-article.js`
4. Marque la publication comme 'published' + envoie une notification email
5. Envoie un recap quotidien par email

**Notifications post-publication** : email envoyé après chaque article publié.
- Destinataires : `NOTIFY_EMAILS` env var (defaut: jeanbaptiste@a26k.ch, sebastien@a26k.ch, benjamin@a26k.ch)
- Contenu : titre, URL, site, date, thème
- Via Resend (secrets/resend.json)

## Deploiement GitHub Actions
- **Workflow** : `.github/workflows/jarvis-daily.yml`
- **Cron** : tous les jours a 5h30 UTC (= 7h30 UTC+2)
- **Dispatch manuel** : possible via Actions > Run workflow
- **Secrets GitHub** (Settings > Secrets > Actions) :
  - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
  - `SANITY_TOKEN`
  - `ANTHROPIC_API_KEY`
  - `BFL_API_KEY` (optionnel, images)
  - `RESEND_API_KEY`, `RESEND_FROM` (notifications email)

## Conventions
- Node.js ESM, pas de Python
- Zero SQL interpolation (mapping statique)
- Zero `execSync` (uniquement `execFileSync`)
- Ecriture atomique (tmp + rename) + file-lock
- Circuit breakers : claude, semrush, flux, sanity
- Validation `validateEnv()` au demarrage
- `sanitizeArticleForLLM()` contre injection de prompts
- Secrets dans `secrets/` (.gitignore), jamais dans le code

## Securite
- Service_role key Supabase dans `secrets/supabase.json` — ne jamais exposer
- Token Sanity Editor dans `secrets/sanity.json`
- ANTHROPIC_API_KEY en variable d'environnement
- BFL_API_KEY en variable d'environnement (optionnel, images)
