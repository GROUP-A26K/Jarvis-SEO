# Plan de split de `scripts/seo-shared.js`

> **Statut** : plan validé, à exécuter dans PR 0.2 (Phase 0).
> **Pré-requis** : aucun — ce document ne modifie aucun fichier de production.
> **Objectif** : éclater `scripts/seo-shared.js` (1171 lignes, 87 déclarations top-level, 60 exports publics) en modules ciblés sous `scripts/lib/*.js`, tout en préservant 100% de la compatibilité ascendante avec les 9 scripts qui l'importent aujourd'hui.

---

## 1. Pourquoi ce split

### Problèmes actuels

1. **Fichier monolithique de 1171 lignes** : difficile à lire, à tester, à modifier.
2. **Changement = risque de régression globale** : toucher 10 lignes peut casser 9 scripts.
3. **Tests unitaires impraticables** : impossible de mocker ou tester une fonction isolée sans charger tout le module.
4. **Couplage temporel** : les caches (`_sitesConfigCache`, `_circuitState`, `_activeLocks`) sont partagés entre scripts qui tournent en parallèle dans GitHub Actions, sans frontière explicite.

### Bénéfices post-split

- **Navigation** : retrouver une fonction devient trivial (`lib/claude.js`, `lib/semrush.js`, ...).
- **Tests ciblés** : on peut `require('./lib/sanitize')` et tester sans charger Supabase, sqlite, etc.
- **Cognitive load réduit** : chaque fichier fait moins de 250 lignes, responsabilité unique.
- **Onboarding** : un futur CTO comprend l'architecture en lisant les noms de fichiers.
- **Préparation PR 0.3 et 0.4** : les prochaines PRs s'appuient sur cette structure modulaire.

---

## 2. Inventaire actuel des exports de `seo-shared.js`

Le `module.exports = {...}` des lignes 1152-1171 contient **60 symboles publics** regroupés ici par famille logique.

### Constantes

- `PATHS` (paths répertoires)
- `CLAUDE_MODEL`, `DEFAULT_MAX_TOKENS`, `CLAUDE_TIMEOUT_MS`
- `EMAIL_RECIPIENTS`, `MAX_ARTICLES_PER_WEEK`
- `VALID_PERSONAS`
- `TIMEOUTS`, `RETRY`
- `SEMRUSH_SESSION_LIMIT`

### Infra : logger, circuit breakers, env

- `logger`
- `circuitBreakers`, `createCircuitBreaker`
- `validateEnv`, `getApiKey`, `requireAnthropicKey`

### Fs utilities

- `ensureDir`, `writeFileAtomic`, `readJSONSafe`, `writeJSONAtomic`
- `acquireLock`, `withLockedJSON`

### Secrets & config

- `loadSecret`
- `loadSitesConfig`, `getSiteConfig`, `getSiteList`, `getSiteLabels`, `invalidateSitesConfigCache`
- `getConfigMeta`, `getSanityDefaults`, `getSanityDocType`
- `getPersonaDetails`, `getSitePersonas`
- `getSiteFallbackCompetitors`, `getSiteSources`, `getSiteEntity`, `getSiteFinma`, `getSiteStableSources`, `getSiteExhibitStyle`

### HTTP & sanitization

- `httpRequest`
- `esc`, `sanitize`, `sanitizeFilename`, `sanitizeSlug`, `sanitizeArticleForLLM`, `sanitizeErrorMessage`

### Intégrations externes

- `rateLimitedSemrushGet`, `rateLimitedSemrushRequest`, `parseSemrushCSV`
- `semrushSessionGuard`, `semrushSessionRecord`, `validateSemrushData`
- `tavilySearch`
- `callClaudeWithRetry`, `extractClaudeText`
- `verifyUrl`
- `sendEmail`

### Tracking & state

- `trackUnits`, `printUnitsSummary`, `loadUnitsState`
- `loadTrackedArticles`, `updateArticleField`
- `loadLatestGapAnalysis`
- `loadPipelineState`, `savePipelineState`

### Validation & helpers

- `validateArticleInput`
- `getISOWeek`

---

## 3. Architecture cible : 15 modules sous `scripts/lib/`

### Convention

- 1 fichier = 1 responsabilité unique
- Taille cible : 50-250 lignes par fichier
- Pas de dépendance circulaire
- Chaque fichier ré-exporte ses symboles via `module.exports`

### Structure proposée

```
scripts/lib/
├── sentry.js              (déjà créé dans PR 0.1b, inchangé)
├── paths.js               NEW  ~25 lignes
├── constants.js           NEW  ~55 lignes
├── logger.js              NEW  ~35 lignes
├── circuit.js             NEW  ~70 lignes
├── env.js                 NEW  ~60 lignes
├── fs-utils.js            NEW  ~40 lignes
├── locks.js               NEW  ~55 lignes
├── secrets.js             NEW  ~20 lignes
├── config.js              NEW  ~175 lignes
├── http.js                NEW  ~50 lignes
├── sanitize.js            NEW  ~50 lignes
├── semrush.js             NEW  ~215 lignes
├── tavily.js              NEW  ~55 lignes
├── claude.js              NEW  ~105 lignes
├── verify.js              NEW  ~40 lignes
├── tracking.js            NEW  ~155 lignes
├── email.js               NEW  ~35 lignes
├── validation.js          NEW  ~30 lignes
└── helpers.js             NEW  ~20 lignes
```

---

## 4. Mapping détaillé : symbole → module cible

| Symbole exporté                                                                                                                | Module cible                | Lignes source (approx) |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ---------------------- |
| `PATHS`                                                                                                                        | `lib/paths.js`              | 35-55                  |
| `CLAUDE_MODEL`, `DEFAULT_MAX_TOKENS`, `CLAUDE_TIMEOUT_MS`                                                                      | `lib/constants.js`          | 56-60                  |
| `EMAIL_RECIPIENTS`, `MAX_ARTICLES_PER_WEEK`                                                                                    | `lib/constants.js`          | 61-62                  |
| `DEFAULT_PLAN_UNITS`, `SEMRUSH_INTERVAL_MS`                                                                                    | `lib/constants.js`          | 64-65                  |
| `VALID_PERSONAS`                                                                                                               | `lib/constants.js`          | 67-72                  |
| `TIMEOUTS`, `RETRY`                                                                                                            | `lib/constants.js`          | 73-99                  |
| `createCircuitBreaker`, `circuitBreakers`, `_circuitState`                                                                     | `lib/circuit.js`            | 100-170                |
| `logger`, `LOG_LEVELS`, `_logLevel`                                                                                            | `lib/logger.js`             | 171-203                |
| `validateEnv`                                                                                                                  | `lib/env.js`                | 204-236                |
| `getApiKey`                                                                                                                    | `lib/env.js`                | 237-261                |
| `requireAnthropicKey`                                                                                                          | `lib/env.js`                | 262-271                |
| `ensureDir`, `writeFileAtomic`                                                                                                 | `lib/fs-utils.js`           | 272-296                |
| `readJSONSafe`, `writeJSONAtomic`                                                                                              | `lib/fs-utils.js`           | 284-302                |
| `acquireLock`, `withLockedJSON`, `cleanupLocks`, `_activeLocks`                                                                | `lib/locks.js`              | 303-376                |
| `loadSecret`                                                                                                                   | `lib/secrets.js`            | 377-390                |
| `loadSitesConfig`, `_sitesConfigCache`                                                                                         | `lib/config.js`             | 391-403                |
| `getSiteConfig`, `getSiteList`, `getSiteLabels`, `invalidateSitesConfigCache`                                                  | `lib/config.js`             | 404-428                |
| `getConfigMeta`, `getSanityDefaults`, `getSanityDocType`                                                                       | `lib/config.js`             | 429-454                |
| `getPersonaDetails`, `getSitePersonas`                                                                                         | `lib/config.js`             | 455-471                |
| `getSiteFallbackCompetitors`, `getSiteSources`, `getSiteEntity`, `getSiteFinma`, `getSiteStableSources`, `getSiteExhibitStyle` | `lib/config.js`             | 472-520                |
| `httpRequest`                                                                                                                  | `lib/http.js`               | 521-563                |
| `esc`, `sanitize`, `sanitizeFilename`, `sanitizeSlug`, `sanitizeArticleForLLM`, `sanitizeErrorMessage`                         | `lib/sanitize.js`           | 564-616                |
| `lastRequestTime`, `requestQueue`, `SEMRUSH_SESSION_LIMIT`, `_semrushSession`                                                  | `lib/semrush.js` (internes) | 617-627                |
| `semrushSessionGuard`, `semrushSessionRecord`                                                                                  | `lib/semrush.js`            | 628-651                |
| `rateLimitedSemrushGet`, `_throttledGet`, `sanitizeSemrushUrl`, `_semrushGetWithBackoff`                                       | `lib/semrush.js`            | 652-728                |
| `tavilySearch`                                                                                                                 | `lib/tavily.js`             | 729-783                |
| `rateLimitedSemrushRequest`, `parseSemrushCSV`, `validateSemrushData`                                                          | `lib/semrush.js`            | 784-829                |
| `loadUnitsState`, `trackUnits`, `printUnitsSummary`                                                                            | `lib/tracking.js`           | 830-878                |
| `callClaudeWithRetry`, `_callClaude`, `extractClaudeText`                                                                      | `lib/claude.js`             | 879-979                |
| `verifyUrl`                                                                                                                    | `lib/verify.js`             | 980-1014               |
| `loadTrackedArticles`, `updateArticleField`                                                                                    | `lib/tracking.js`           | 1015-1074              |
| `loadLatestGapAnalysis`                                                                                                        | `lib/tracking.js`           | 1075-1087              |
| `loadPipelineState`, `savePipelineState`                                                                                       | `lib/tracking.js`           | 1088-1104              |
| `sendEmail`                                                                                                                    | `lib/email.js`              | 1105-1123              |
| `validateArticleInput`                                                                                                         | `lib/validation.js`         | 1124-1138              |
| `getISOWeek`                                                                                                                   | `lib/helpers.js`            | 1139-1150              |

**Total mappé : 60 exports publics + symboles internes préservés.**

---

## 5. Graphe de dépendances entre modules

Ordre idéal de création (du plus basique au plus dépendant), calculé pour éviter toute dépendance circulaire :

```
Niveau 0 (aucune dépendance sur les autres modules):
  paths.js
  constants.js
  logger.js

Niveau 1 (dépend de niveau 0):
  fs-utils.js       → logger.js
  secrets.js        → paths.js, logger.js
  env.js            → logger.js, secrets.js
  circuit.js        → logger.js
  sanitize.js       → (pur helpers, aucune dep)
  helpers.js        → (pur helpers, aucune dep)

Niveau 2 (dépend des niveaux 0-1):
  http.js           → logger.js
  locks.js          → paths.js, logger.js, fs-utils.js
  config.js         → paths.js, logger.js, fs-utils.js

Niveau 3 (dépend des niveaux 0-2):
  tracking.js       → paths.js, logger.js, fs-utils.js, constants.js
  verify.js         → http.js, logger.js
  email.js          → constants.js, secrets.js, http.js, logger.js
  claude.js         → logger.js, http.js, circuit.js, constants.js
  validation.js     → logger.js

Niveau 4 (intégrations externes complexes):
  semrush.js        → logger.js, http.js, circuit.js, constants.js, tracking.js
  tavily.js         → logger.js, http.js, circuit.js, secrets.js
```

**Zéro cycle**, chaque module dépend uniquement de modules créés avant lui.

---

## 6. Stratégie de compatibilité ascendante

### Le problème

`seo-shared.js` est importé par 9 scripts :

- `workflow-daily.js`
- `workflow-single-task.js`
- `seo-orchestrator.js`
- `seo-publish-article.js`
- `seo-weekly-report.js`
- `seo-images.js`
- `seo-exhibits.js`
- `seo-gap-analysis.js`
- `calendar-connector.js`

Si on casse leur import, tout le pipeline meurt en prod. **Inacceptable.**

### La solution : le fichier d'indirection

On garde `scripts/seo-shared.js` en vie comme **re-exporter** minimal :

```js
// scripts/seo-shared.js (après PR 0.2)
// Backward-compatible re-exporter. Do not add logic here.
// All new code should import from specific modules under scripts/lib/.

const paths = require('./lib/paths');
const constants = require('./lib/constants');
const logger_mod = require('./lib/logger');
const circuit = require('./lib/circuit');
const env = require('./lib/env');
const fsu = require('./lib/fs-utils');
const locks = require('./lib/locks');
const secrets = require('./lib/secrets');
const config = require('./lib/config');
const http = require('./lib/http');
const sanitize = require('./lib/sanitize');
const semrush = require('./lib/semrush');
const tavily = require('./lib/tavily');
const claude = require('./lib/claude');
const verify = require('./lib/verify');
const tracking = require('./lib/tracking');
const email = require('./lib/email');
const validation = require('./lib/validation');
const helpers = require('./lib/helpers');

module.exports = {
  // Identical shape to the old module.exports.
  // Maintained for backward compatibility with the 9 existing scripts.
  PATHS: paths.PATHS,
  CLAUDE_MODEL: constants.CLAUDE_MODEL,
  DEFAULT_MAX_TOKENS: constants.DEFAULT_MAX_TOKENS,
  // ... (60 symboles, identique à l'original)
};
```

### Avantages

- 9 scripts existants : aucune ligne à toucher.
- Nouveaux scripts : peuvent importer directement `require('./lib/claude')`.
- Migration progressive possible script par script dans des PRs séparées.

### Règle de migration

- Cette PR 0.2 : on crée les 15 modules + on reconstruit `seo-shared.js` comme re-exporter.
- PRs ultérieures optionnelles : chaque script migre vers les imports directs quand il est modifié pour une autre raison.

---

## 7. Pièges identifiés et comment les éviter

### Piège 1 : les caches globaux

Les variables `_circuitState`, `_sitesConfigCache`, `_activeLocks`, `_semrushSession`, `lastRequestTime`, `requestQueue`, `_logLevel` sont des **module-level state**.

Quand un module est `require`-é plusieurs fois dans Node, Node ne l'exécute qu'une fois (cache de modules). Donc ces caches restent corrects tant que chaque module est chargé une seule fois, au même endroit logique.

**Action** : garder chaque cache dans le module de sa fonction, jamais dupliqué.

- `_sitesConfigCache` DOIT vivre dans `lib/config.js`.
- `_activeLocks` DOIT vivre dans `lib/locks.js`.
- `_semrushSession` DOIT vivre dans `lib/semrush.js`.

### Piège 2 : lazy `require('better-sqlite3')`

Dans `loadTrackedArticles` (ligne 1017) et `updateArticleField` (ligne 1047), le require est lazy (à l'intérieur de la fonction) pour éviter le coût de chargement sqlite si non utilisé.

**Action** : conserver ce lazy require dans `lib/tracking.js`. Ne PAS le remonter en haut du fichier.

### Piège 3 : ordre des exports dans `module.exports`

L'ancien fichier exporte dans un certain ordre. L'ordre n'a pas d'importance sémantique en JS, mais un diff git sera plus lisible si on le préserve.

**Action** : reconstruire `seo-shared.js` avec le même ordre d'exports que l'original.

### Piège 4 : `cleanupLocks` n'est PAS exporté mais utilisé

`cleanupLocks` (ligne 353) ne figure pas dans `module.exports`. Il est probablement appelé via un handler `process.on('exit')` interne à `seo-shared.js`.

**Action** : vérifier à la lecture ligne par ligne. Si c'est bien un handler auto-registered, le déplacer dans `lib/locks.js` avec son `process.on('exit')` préservé.

### Piège 5 : variables internes avec un nom similaire

`_callClaude` est interne, `callClaudeWithRetry` est public. Même convention pour `_throttledGet` interne vs `rateLimitedSemrushGet` public.

**Action** : distinguer clairement dans chaque module ce qui va dans `module.exports` (public) de ce qui reste privé.

### Piège 6 : les circuit breakers nommés

`circuitBreakers` est un objet avec des breakers pré-créés par service (`semrush`, `claude`, `flux`, etc.). Ces instances sont partagées entre tous les callers.

**Action** : instancier `circuitBreakers` au chargement de `lib/circuit.js`. Chaque require ultérieur reçoit la même instance (grâce au cache Node).

### Piège 7 : `process.env.EMAIL_RECIPIENTS` lu à l'import

Ligne 61 : `EMAIL_RECIPIENTS = process.env.EMAIL_RECIPIENTS.split(...)` est évalué au chargement du module. Si on déplace ça dans `lib/constants.js` qui se charge tôt, on garde le même timing. Aucun souci à prévoir mais à noter.

### Piège 8 : `sendEmail` et intégration Resend

`sendEmail` lit probablement `secrets/resend.json` via `loadSecret`. Cette dépendance doit bien être dans `lib/email.js` → `require('./secrets')`.

---

## 8. Plan d'exécution de PR 0.2 (step-by-step)

### Étape 1 : Préparer

- Créer la branche `feature/JB/seo-split-shared-module` depuis `main` (fenêtre verte).
- Relire ce plan (`docs/SEO_SHARED_SPLIT_PLAN.md`).
- `wc -l scripts/seo-shared.js` → confirmer 1171 lignes.
- Lire `seo-shared.js` intégralement une première fois pour vérifier l'inventaire.

### Étape 2 : Créer les modules niveau 0 (3 fichiers)

- `lib/paths.js`
- `lib/constants.js`
- `lib/logger.js`
- `node -e "require('./scripts/lib/paths'); console.log('OK')"` sur chaque.

### Étape 3 : Créer les modules niveau 1 (6 fichiers)

- `lib/sanitize.js`, `lib/helpers.js`, `lib/fs-utils.js`, `lib/secrets.js`, `lib/env.js`, `lib/circuit.js`.
- Test de chargement pour chaque.

### Étape 4 : Créer les modules niveau 2 (3 fichiers)

- `lib/http.js`, `lib/locks.js`, `lib/config.js`.

### Étape 5 : Créer les modules niveau 3 (5 fichiers)

- `lib/tracking.js`, `lib/verify.js`, `lib/email.js`, `lib/claude.js`, `lib/validation.js`.

### Étape 6 : Créer les modules niveau 4 (2 fichiers)

- `lib/semrush.js`, `lib/tavily.js`.

### Étape 7 : Reconstruire `seo-shared.js` comme re-exporter

- 15 requires en tête.
- 1 `module.exports` fidèle à l'original (60 symboles, même ordre).

### Étape 8 : Tests de non-régression

- `node tests/test-all.js` doit passer (idem avant).
- `node scripts/setup-check.js` doit passer.
- `npm run status` doit afficher l'état du pipeline sans crash.
- Pour chaque script, `node <script> --help` (ou `--dry-run` quand dispo) ne doit rien casser.

### Étape 9 : Smoke test manuel

- Depuis la webapp Jarvis-Calendar en preview, lancer une génération de brouillon Jarvis sur un article bidon.
- Vérifier dans Sentry (projet `jarvis-seo`) qu'aucune erreur nouvelle n'apparaît.
- Les logs des fonctions doivent être identiques à avant (même format, même ordre).

### Étape 10 : Commit, push, PR

- 1 commit par niveau est possible mais un seul "feat(seo): split seo-shared.js into lib modules" est plus simple.
- PR décrit le plan suivi, lie vers `docs/SEO_SHARED_SPLIT_PLAN.md`.
- Checklist : build local OK, tests passent, smoke test fait.

---

## 9. Ce qui N'EST PAS dans cette PR (hors scope)

Pour garder la PR 0.2 focalisée et minimale :

- ❌ Pas de refactor logique. On déplace, on ne réécrit pas.
- ❌ Pas de tests unitaires ajoutés (suivra en PR dédiée).
- ❌ Pas de changement d'API publique (tous les exports gardent leur nom exact).
- ❌ Pas de migration des scripts vers des imports directs `require('./lib/xxx')` (prévu en suivant).
- ❌ Pas de split de `seo-publish-article.js` (1118 lignes, prévu en PR future).
- ❌ Pas de split de `seo-orchestrator.js`, `seo-images.js`, `seo-exhibits.js`.

---

## 10. Risques résiduels et mitigations

| Risque                                                  | Probabilité | Impact | Mitigation                                    |
| ------------------------------------------------------- | ----------- | ------ | --------------------------------------------- |
| Dépendance circulaire découverte en cours de route      | Faible      | Élevé  | Ordre par niveaux (§5) garantit un DAG        |
| Cache global cassé (2 instances de `_sitesConfigCache`) | Faible      | Élevé  | Règle : 1 cache = 1 module, jamais dupliqué   |
| Import manqué dans `seo-shared.js` re-exporter          | Moyen       | Élevé  | Test : diff des 60 exports avant/après        |
| `cleanupLocks` (non exporté) cassé silencieusement      | Moyen       | Moyen  | Relire ligne 353 et préserver handlers        |
| Timing de lecture de `process.env` différent            | Faible      | Faible | Charger `constants.js` tôt dans seo-shared.js |
| Sentry reste OK ?                                       | Faible      | Moyen  | `lib/sentry.js` déjà en place, non modifié    |

---

## 11. Temps estimé et découpage d'exécution

- **Étape 1** : 15 min (branche + lecture seo-shared.js).
- **Étapes 2-6** : ~60 min (création des 15 modules, avec test de chargement à chaque).
- **Étape 7** : 15 min (re-exporter seo-shared.js).
- **Étape 8** : 15 min (tests de non-régression).
- **Étape 9** : 15 min (smoke test bout-en-bout).
- **Étape 10** : 10 min (commit + push + PR).

**Total : environ 2h** en session concentrée. Avec des pauses, 2h30.

Cette PR est plus grosse que PR 0.1 (1h30 chacune) mais plus mécanique. Le gros du travail cognitif est dans ce plan. L'exécution est du déplacement de code contrôlé.

---

## 12. Go/No-Go pour lancer PR 0.2

### Critères GO

- ✅ Ce plan lu et validé par JB.
- ✅ Sentry jarvis-seo opérationnel (PR 0.1b mergée).
- ✅ Main branch stable, pas de PR en cours.
- ✅ Créneau de 2h30 dispo, pas d'urgence prod.
- ✅ 2 fenêtres VS Code séparées (règle dual-terminal).

### Critères NO-GO (reporter)

- ❌ Article critique à publier dans les prochaines heures.
- ❌ Fatigue cognitive (fin de journée, sortie de meeting long).
- ❌ Besoin d'un déploiement Jarvis-SEO urgent sur main.

---

_Plan rédigé le 2026-04-17. À exécuter en PR 0.2 dans une session dédiée._
