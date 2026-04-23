# scripts/handlers/

Handlers applicatifs — couche d'orchestration business.

## Rôle

Un handler consomme des **primitives** (de `scripts/lib/`) et des **adapters**
(pour l'instant `scripts/calendar-connector.js`, futurs `scripts/adapters/*`)
pour réaliser un cas d'usage métier complet : traiter une tâche, publier un
article planifié, régénérer un exhibit, etc.

Les handlers ne sont **pas** des entrypoints — ils sont appelés depuis les
entrypoints `workflow-*.js` à la racine de `scripts/`.

## Règles de dépendance

Un handler peut importer :

- `scripts/lib/*` (primitives pures — niveau DAG 0-4)
- `scripts/seo-shared.js` (re-exporter des primitives de lib, équivalent)
- `scripts/calendar-connector.js` (adapter Supabase, à migrer vers `scripts/adapters/` plus tard)
- `scripts/seo-exhibits.js` exports (`planExhibits`, `processExhibit` — à migrer)
- `scripts/seo-publish-article.js` exports (`publishToSanity`, `uploadImageToSanity` — à migrer)

Un handler ne doit **jamais** :

- Être importé depuis `scripts/lib/*` (casserait le DAG de la lib pure)
- Importer un autre handler (évite les cycles — si besoin de logique partagée,
  extraire vers un helper privé au module ou une primitive dans `lib/`)

## Convention d'appel

Les handlers acceptent tous la signature `(task|pub, ctx)` :

- `task` ou `pub` : la ligne Supabase à traiter
- `ctx` : un objet contenant toutes les dépendances du handler (client Supabase,
  fonctions d'adapter, flags de comportement). Dépendance injection explicite,
  pas de singletons. Le dispatcher (workflow-\*.js) construit le ctx et l'injecte.

Les handlers throw sur erreur inattendue. Le dispatcher attrape et décide (compter,
continuer, exit).

## Contenu actuel (PR 0.4)

`task-handlers.js` expose **6 symboles** :

### Helpers purs

- `runArticle(site, keyword, flags, apiKey, taskId)` — lance le pipeline SEO
  via `execFileSync` et lit le TaskResult JSON (PR 0.3). Retourne
  `{ stdout, result, outputJsonPath, execError }`.
- `sendPublicationNotification(site, title, theme, url)` — envoie un email
  HTML de notification post-publication réussie.

### Handlers business

- `handleScheduledPublication(pub, ctx)` — traite une publication planifiée
  depuis le cron quotidien. **Daily-only**. Retourne `'published' | 'skipped'`.
- `handlePublishDraft(task, ctx)` — publie un `draft_content` existant vers
  Sanity. **Partagé** entre daily (cron batch) et single-task (on-demand).
  Retourne `'published'`.
- `handleRegenerateExhibit(task, ctx)` — régénère un exhibit pour un draft
  existant et upload vers Supabase Storage. **Single-task only**.
- `handleGenerateArticle(task, ctx)` — lance le pipeline SEO complet (mode
  draft-only ou publish selon `task.action`). **Partagé** entre daily et
  single-task. Retourne `'tasks'`.

## Divergences préservées

Certains comportements diffèrent entre les call-sites daily et single-task.
Ces divergences sont modélisées via les flags du `ctx` pour préserver
**exactement** le comportement observable pré-PR-0.4 :

- `dryRun` — daily peut être en mode dry-run (skip side-effects), single jamais
- `logPrefix`, `trailingNewline`, `logPublishedOk`, `logGenericOk`, `announceTask` — formatage
  des logs (indentation, newlines) qui différait entre les 2 workflows
- `uploadExhibitsToStorage` — true dans single-task uniquement : daily-cron
  **ne uploade pas** les exhibits vers Supabase Storage quand il traite un
  task draft. Préserve le comportement existant ; à corriger dans une PR
  dédiée (voir `JARVIS_CONTEXT.md` Known issues).

## Voir aussi

- `JARVIS_CONTEXT.md` section "Architecture — couches Jarvis-SEO"
- `scripts/lib/` — primitives pures
- `scripts/lib/task-result.js` — contrat JSON entre pipeline et workflows (PR 0.3)
