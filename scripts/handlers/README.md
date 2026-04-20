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
- `scripts/calendar-connector.js` (adapter Supabase, à migrer vers `scripts/adapters/` plus tard)
- `scripts/seo-publish-article.js` exports (`publishToSanity`, `uploadImageToSanity` — à migrer vers `scripts/adapters/sanity.js` plus tard)

Un handler ne doit **jamais** :
- Être importé depuis `scripts/lib/*` (casserait le DAG de la lib pure)
- Importer un autre handler (évite les cycles — si besoin de logique partagée,
  extraire vers un helper privé au module ou une primitive dans `lib/`)

## Contenu actuel

- `task-handlers.js` — helpers et handlers partagés entre `workflow-daily.js`
  et `workflow-single-task.js` (PR 0.4)

## Voir aussi

- `JARVIS_CONTEXT.md` section "Architecture — couches Jarvis-SEO"
- `scripts/lib/` — primitives pures
