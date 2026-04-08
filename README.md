# Scripts SEO v5 — Groupe Genevoise

Workflow SEO automatise pour les 5 sites du Groupe Genevoise.
**Jarvis One** — A26K Group.

---

## Architecture

```
scripts/
  seo-shared.js              # Module partage (rate limiter, units, Claude retry, URL verify)
  seo-gap-analysis.js        # Script 1 : gap analysis
  seo-publish-article.js     # Script 2 : publication article
  seo-weekly-report.js       # Script 3 : rapport hebdomadaire
  seo-orchestrator.js        # Script 4 : orchestrateur workflow
  README.md
sites/
  config.json                # Configuration partagee des 5 sites (siteContext, imageStyle, personas)
secrets/
  semrush.json               # { "api_key": "...", "plan": "standard" }
  google-oauth.json           # OAuth2 credentials
  sanity.json                # { "token": "..." }
  resend.json                # { "api_key": "...", "from": "noreply@..." }
data/
  seo-tracking.db            # SQLite (auto-cree)
  articles-tracking.json     # JSON fallback
  semrush-units.json         # Compteur units (auto)
  semrush-domain-history.json # Historique volumes (validation)
  pipeline-state.json        # Etat du pipeline orchestrateur
  style_memory.json          # Prompts PASS recents (script images)
  lessons_learned.json       # Corrections Agent 2 (script images)
  prompt_cache.json          # Cache thematique prompts (script images)
images/
  plan-{slug}.json           # Contrat d'interface orchestrateur → script images
  result-{slug}.json         # Metadonnees SEO produites par le script images
  {slug}-{desc}-hero.jpg     # Images produites par le script images
  {slug}-{desc}-inline.jpg
reports/
  gap-analysis-YYYY-MM-DD.json
  plan-YYYY-WNN.json         # Plan strategique
  plan-approved-YYYY-WNN.json # Plan approuve (optionnel)
  seo-weekly-YYYY-WNN.html/json/pdf
  article-dryrun-*.json
```

## Prerequis

- Node.js 18+
- `npm install better-sqlite3` (optionnel, JSON fallback)
- `wkhtmltopdf` (optionnel, pour PDF)
- `ANTHROPIC_API_KEY` en variable d'environnement

---

## Module partage : `seo-shared.js`

Fonctions partagees entre les 3 scripts :

- **Rate limiter Semrush** : queue serialisee 8 req/s, retry 429 automatique
- **Units tracker** : compteur 50k units/mois, alerte 80%, reset mensuel
- **Claude API retry** : 3 tentatives, backoff 1s/3s/9s, retry sur 529/500/timeout
- **Validation Semrush** : alerte si un domaine retourne < 30% de son historique
- **URL verification** : HEAD request pour verifier les liens sources

---

## Script 1 : `seo-gap-analysis.js`

```bash
node scripts/seo-gap-analysis.js
node scripts/seo-gap-analysis.js --site medcourtage.ch
```

Features :

- Keyword gap intent-weighted (transactional x2.0, commercial x1.5)
- **Concurrents dynamiques** via `domain_organic_organic` (fallback sur hardcodes)
- **Trending keywords** : top 5 gaps enrichis avec tendance 12 mois
- **Featured snippets analysis** : gaps + capturable (pos 2-10 avec FS existant)
- Content gap par URL (pages thematiques manquantes, coverage < 30%)
- Cannibalization check (meme keyword, plusieurs URLs, top 50)
- Cluster detection (pillar/cluster opportunities)
- Semrush data validation (alerte si volumes anormaux)

---

## Script 2 : `seo-publish-article.js`

```bash
# Dry-run avec persona auto-select
node scripts/seo-publish-article.js --site medcourtage.ch --keyword "rc pro medecin geneve" --dry-run

# Publication avec persona explicite
node scripts/seo-publish-article.js --site fiduciaire-genevoise.ch --keyword "creer sa sarl geneve" --persona "Elodie Rochat"

# Forcer republication
node scripts/seo-publish-article.js --site medcourtage.ch --keyword "rc pro medecin geneve" --force
```

| Flag | Description |
|------|-------------|
| `--site` | Site cible (requis) |
| `--keyword` | Mot-cle cible (requis) |
| `--persona` | Persona (optionnel, auto-select si absent) |
| `--dry-run` | Pas de publication, sauvegarde JSON |
| `--force` | Ignore le check anti-duplication |

Pipeline en 6 etapes :

1. Brief semantique (Semrush overview + related + SERP top 5)
2. Redaction FR avec **citation-ready snippets** et **sourceUrls**
   - Extraits citables (20-40 mots, fait + chiffre + source)
   - URLs sources completes (https://admin.ch/...)
   - **Verification URLs** par HEAD request (liens morts supprimes)
3. Traduction EN avec adaptation keyword (volume check CH)
4. Score GEO 100 pts sur 7 dimensions :
   - P1 Cleanness (15), P2 Persona (20), P3 GEO (25)
   - P4 Perplexity **sliding window 200 mots** (15)
   - P5 Schema (10), P6 Citations (10), **P7 Sources verifiees (5)**
   - **Topical coverage validation** via Claude (score 0-10, declenche patch si < 5)
   - Patch cible (vs reecriture complete) si score < 65 ou coverage < 5
5. **Disclaimer contextuel** genere par Claude (unique par article, fallback statique)
6. Publication Sanity avec :
   - **Sommaire/TOC** dans le body Portable Text
   - **Article schema JSON-LD** (auteur persona, publisher entite legale, datePublished)
   - **Speakable schema** pointant vers citableExtracts
   - FAQ schema JSON-LD
   - **GEO visibility monitoring** (cited/partial/absent via Claude)

Apres publication : tracking SQLite/JSON (J+30/60/90), maillage interne.

---

## Script 3 : `seo-weekly-report.js`

```bash
node scripts/seo-weekly-report.js
node scripts/seo-weekly-report.js --week 2026-W14
```

Features :

- GSC data + Semrush positions par site
- Tracking article par article J+30/60/90 (domain cache)
- **CTR monitoring** : compare CTR reel vs attendu par position, alerte si ratio < 50%
- **Content decay detection** : articles 6+ mois avec perte de 10+ positions vs meilleur historique
- **GEO visibility recurrent** : recheck max 5 articles/run via Claude
- Rapport HTML professionnel (KPIs, business lines, tracking, CTR alertes, content decay, GEO visibility, top 3 gaps)
- PDF via wkhtmltopdf
- Email leger (resume + nombre alertes) + PDF en PJ via Resend

---

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

## Cron suggere

```cron
# Gap analysis : lundi 6h
0 6 * * 1 cd /path/to/project && node scripts/seo-gap-analysis.js >> logs/gap.log 2>&1

# Orchestrateur plan : lundi 6h30
30 6 * * 1 cd /path/to/project && ANTHROPIC_API_KEY=sk-... node scripts/seo-orchestrator.js --plan >> logs/orchestrator.log 2>&1

# Rapport hebdo : lundi 8h
0 8 * * 1 cd /path/to/project && ANTHROPIC_API_KEY=sk-... node scripts/seo-weekly-report.js >> logs/weekly.log 2>&1
```

---

## Script 4 : `seo-orchestrator.js`

Orchestrateur du workflow SEO. Coordonne gap analysis, publication, et agent DA/images.

```bash
# Phase 1: Analyse + plan strategique (Claude Strategist)
node scripts/seo-orchestrator.js --plan

# Phase 2: Execute les dry-runs + genere les briefs DA
node scripts/seo-orchestrator.js --execute

# Phase 3: Publie les articles approuves
node scripts/seo-orchestrator.js --publish

# Etat du pipeline
node scripts/seo-orchestrator.js --status
```

### Workflow complet

1. **`--plan`** : charge le gap analysis + tracking + budget units. Appelle Claude Strategist pour selectionner les meilleurs articles de la semaine avec raisonnement strategique (diversification clusters, trending, featured snippets, content refresh). Produit `plan-YYYY-WNN.json` et envoie un email de review.

2. **Review humain** : modifier le plan JSON (mettre `status: "approved"` sur les articles valides). Ou creer un fichier `plan-approved-YYYY-WNN.json`.

3. **`--execute`** : pour chaque article approuve, lance un dry-run (script 2 `--dry-run`). Genere des briefs DA dans `images/brief-*.json` pour l'agent images. Verifie si les images sont pretes (convention: `images/{slug}-hero.*`). Peut etre relance plusieurs fois (idempotent).

4. **Agent DA/Images** : recoit les briefs, produit les images, les depose dans `images/`.

5. **`--publish`** : publie les articles prets via le script 2 (sans `--dry-run`, avec `--force`). Envoie un email de resume.

### Pipeline state

L'etat du pipeline est stocke dans `data/pipeline-state.json`. Chaque article a un statut :

```
planned -> approved -> dry_run_done -> ready_for_review -> published
                    -> dry_run_failed
                                                        -> publish_failed
```

### Image Plans (contrat d'interface script images)

L'orchestrateur depose dans `images/plan-{slug}.json` un contrat que le script images (`seo-images.js`) consomme :

```json
{
  "slug": "rc-pro-medecin-geneve",
  "site": "medcourtage.ch",
  "persona": "Hugo Schaller",
  "keyword": "rc pro medecin geneve",
  "dryRunPath": "reports/article-dryrun-medcourtage.ch-1712487600.json",
  "siteContext": {
    "secteur": "Assurance medicale / courtage sante",
    "ton": "Expert, technique, ancrage FINMA et FMH",
    "public": "Medecins FMH, professions liberales medicales",
    "palette": ["#1a1a2e", "#2c5f7c", "#e8d5b7"],
    "exemples_articles": "RC Pro medecin, prevoyance LPP..."
  }
}
```

Le script images lit ce plan, charge l'article depuis le dry-run, execute Agent 0 (plan d'illustration) → Agent 1 (prompts Flux 2) → Flux batch → Agent 2 (evaluation) → Sharp (post-traitement), et depose :

- `images/{slug}-{descripteur}-{role}.jpg` : les images finales
- `images/result-{slug}.json` : metadonnees SEO (filenames, alt_text, positions, couts)

L'orchestrateur detecte `result-{slug}.json` au prochain `--execute` et passe l'article en `ready_for_review`.

## Sites

- medcourtage.ch (Assurance medicale, FINMA)
- fiduciaire-genevoise.ch / fiduciairevaudoise.ch (Fiduciaire GE/VD)
- relocation-genevoise.ch (Relocation)
- assurance-genevoise.ch (Courtage assurance, FINMA)
