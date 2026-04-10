# Jarvis SEO v7 — Groupe Genevoise

Workflow SEO automatise pour les sites du Groupe Genevoise.
**Jarvis One** — A26K Group.

---

## Architecture

```
scripts/
  seo-shared.js              # Module central (58 exports)
  seo-gap-analysis.js        # Script 1 : gap analysis
  seo-publish-article.js     # Script 2 : publication article
  seo-weekly-report.js       # Script 3 : rapport hebdomadaire
  seo-orchestrator.js        # Script 4 : orchestrateur workflow
  seo-images.js              # Script 5 : pipeline images AI
  calendar-connector.js      # Adaptateur Supabase (Jarvis Calendar)
  workflow-daily.js           # Cron quotidien Calendar → SEO pipeline
sites/
  config.json                # Configuration centralisee (single source of truth)
tests/
  test-all.js                # 65 tests unitaires
secrets/                     # .gitignore — JAMAIS commite
  semrush.json               # { "api_key": "...", "plan": "standard" }
  supabase.json              # { "url": "...", "service_role_key": "..." }
  google-oauth.json           # OAuth2 credentials
  sanity.json                # { "token": "..." }
  resend.json                # { "api_key": "...", "from": "noreply@..." }
data/                        # Runtime, auto-genere
  seo-tracking.db            # SQLite
  articles-tracking.json     # JSON fallback
  semrush-units.json         # Compteur units
  pipeline-state.json        # Etat du pipeline
  style_memory.json          # Prompts PASS (images)
  lessons_learned.json       # Corrections Agent 2
  prompt_cache.json          # Cache thematique prompts
images/                      # Images generees
reports/                     # Rapports generes
```

## Module central : `seo-shared.js`

58 exports couvrant :

- **Logger structure** : `logger.info/warn/error/debug` avec formatage uniforme
- **Paths** : `PATHS.reports`, `PATHS.db`, `PATHS.images`, etc.
- **Config dynamique** : `getSiteList()`, `getSiteConfig(site)`, `getSiteLabels()`, `getSanityDefaults()`, `getSanityDocType(site)`, `getPersonaDetails(persona)`, `getSitePersonas(site)`, `getSiteFallbackCompetitors(site)`, `getSiteSources(site)`, `getSiteEntity(site)`, `getSiteFinma(site)`
- **File I/O** : ecriture atomique (`writeJSONAtomic`), file-lock (`withLockedJSON`)
- **HTTP** : `httpRequest()` avec timeouts configurables
- **Semrush** : rate limiter 8 req/s, retry 429 backoff exponentiel (3 retries), circuit breaker
- **Claude API** : retry avec backoff (1s/3s/9s), support vision/multimodal, circuit breaker, validation reponse 5MB
- **Circuit breakers** : claude, semrush, flux, sanity (seuils/cooldowns configurables)
- **Timeouts** : 9 services configurables (claude 180s, semrush 15s, sanity 30s, flux 60s, etc.)
- **Securite** : `sanitize()`, `sanitizeFilename()`, `sanitizeArticleForLLM()`, `esc()`, `validateEnv()`, `validateArticleInput()`

## Prerequis

- Node.js 18+
- `npm install` (better-sqlite3, sharp)
- `wkhtmltopdf` (optionnel, pour PDF)
- `ANTHROPIC_API_KEY` en variable d'environnement
- `BFL_API_KEY` pour generation images (optionnel)

## Commandes

```bash
npm test                          # 65 tests unitaires
npm run gap                       # Gap analysis
npm run gap -- --site medcourtage.ch
npm run publish -- --site medcourtage.ch --keyword "rc pro medecin" --dry-run
npm run plan                      # Orchestrateur : plan strategique
npm run execute                   # Orchestrateur : dry-runs + briefs DA
npm run deploy                    # Orchestrateur : publication
npm run status                    # Etat du pipeline
npm run images                    # Pipeline images (tous les plans)
npm run images:dry                # Images dry-run (LLM seul)
npm run report                    # Rapport hebdomadaire
npm run workflow                  # Cron quotidien Calendar (publications + taches)
```

## Configuration : `sites/config.json`

Single source of truth. Ajouter un site = ajouter une entree, zero changement dans les scripts.

```json
{
  "_meta": {
    "sanityDefaults": { "projectId": "...", "dataset": "...", ... },
    "personasDetails": { "Hugo Schaller": { "style": "..." }, ... }
  },
  "monsite.ch": {
    "label": "Mon Site",
    "entity": "Mon Entreprise SA",
    "verticale": "Mon Secteur",
    "finma": null,
    "siteContext": { "secteur": "...", "ton": "...", "public": "...", "palette": [...] },
    "sources": "source1.ch, source2.ch",
    "personas": ["Persona 1", "Persona 2"],
    "fallbackCompetitors": ["concurrent1.ch", "concurrent2.ch"],
    "sanity": { "documentType": "monsiteBlogPost" },
    "imageStyle": { ... }
  }
}
```

## Workflow complet

1. **Gap analysis** (lundi 6h) : `npm run gap`
2. **Plan strategique** (lundi 6h30) : `npm run plan` → email de review
3. **Review humain** : modifier `plan-approved-YYYY-WNN.json`
4. **Execution** : `npm run execute` → dry-runs + briefs images
5. **Images** : `npm run images` → generation AI (Flux 2)
6. **Publication** : `npm run deploy` → Sanity CMS
7. **Rapport** (lundi 8h) : `npm run report` → email + PDF

## Securite

- Zero SQL interpolation (mapping statique de requetes preparees)
- Zero `execSync` (uniquement `execFileSync`, pas d'injection shell)
- Zero `catch {}` silencieux (tous logges)
- Zero secrets dans le code (`.gitignore` protege `secrets/`)
- Validation des reponses externes (taille max, MIME, format)
- Validation `validateEnv()` au demarrage de chaque script
- `sanitizeArticleForLLM()` contre l'injection de prompts
- Circuit breakers pour eviter le spam de services en panne
- Ecriture atomique (tmp + rename) + file-lock pour les fichiers partages

## GEO Visibility

La fonction `checkGEOVisibility` est une **heuristique** : elle demande a Claude d'estimer si un article serait cite par Google AI Overview ou Perplexity. Claude n'a pas acces aux donnees reelles de ces services — le score est une estimation basee sur la structure de l'article, ses citations, et son ancrage thematique. Utile comme indicateur relatif, pas comme metrique absolue.

## Personas (8)

| Persona | Sites |
|---------|-------|
| Hugo Schaller | medcourtage.ch |
| Amelie Bonvin | medcourtage.ch |
| Marc Favre | fiduciaire-genevoise.ch, fiduciairevaudoise.ch |
| Elodie Rochat | fiduciaire-genevoise.ch, fiduciairevaudoise.ch |
| Lucas Morel | relocation-genevoise.ch |
| Sofia Meier | relocation-genevoise.ch |
| Philippe Dufour | assurance-genevoise.ch |
| Nathalie Berger | assurance-genevoise.ch |

## Exhibits (infographies de donnees)

Pipeline de generation d'exhibits style BCG : tableaux comparatifs, timelines, metriques cles.

Architecture : Claude (donnees) → SVG pixel-perfect → Sharp (PNG 2x) → Gemini 3.1 Flash (style editorial) → Agent 3 (verification integrite) → Sanity.

L'Agent 3 compare le SVG source et la version Gemini : si un seul chiffre, mot ou reference legale est altere, fallback automatique sur le SVG rasterise. Max 3 retries Gemini.

Chaque site a son propre style editorial (`exhibitStyle` dans `config.json`) : palette, texture, directive Gemini.

```bash
npm run exhibits:test           # Genere un exhibit de test
npm run exhibits:dry            # Dry-run (SVG seulement, pas de Gemini)
```

## Cron suggere

```cron
# Gap analysis : lundi 6h
0 6 * * 1 cd /path/to/project && node scripts/seo-gap-analysis.js >> logs/gap.log 2>&1

# Plan : lundi 6h30
30 6 * * 1 cd /path/to/project && node scripts/seo-orchestrator.js --plan >> logs/orchestrator.log 2>&1

# Rapport : lundi 8h
0 8 * * 1 cd /path/to/project && node scripts/seo-weekly-report.js >> logs/weekly.log 2>&1

# Calendar daily workflow : tous les jours 7h
0 7 * * * cd /path/to/project && node scripts/workflow-daily.js >> logs/workflow-daily.log 2>&1
```
