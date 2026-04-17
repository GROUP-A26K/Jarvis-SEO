# Sentry - Jarvis-SEO

## Overview

Error monitoring for Jarvis-SEO Node.js pipeline scripts via `@sentry/node`.
The shared module is `scripts/lib/sentry.js` and is required by the 5
entrypoints: workflow-daily, workflow-single-task, seo-orchestrator,
seo-publish-article, seo-weekly-report.

Scripts are ephemeral (CLI processes that exit when done), so the module
handles `flush()` before `process.exit()` via the `fatal()` helper.

## Configuration

### Environments
- `production` - GitHub Actions runs (daily cron + on-demand workflow_dispatch)
- `development` - local runs (Sentry disabled by default, no events sent)

No `preview` environment here since there is no web deployment preview
for this repo (scripts only run in CI or locally).

### GitHub Secrets

| Secret | Where | Purpose |
|---|---|---|
| `SENTRY_DSN_SEO` | Repo secret | Client DSN for @sentry/node |

No `SENTRY_AUTH_TOKEN` needed (no sourcemaps to upload - Node stack traces
are already readable).

### Environment variables (set by workflows)

The two workflows (`jarvis-daily.yml`, `jarvis-on-demand.yml`) inject:

```yaml
env:
  SENTRY_DSN_SEO: ${{ secrets.SENTRY_DSN_SEO }}
  SENTRY_ENVIRONMENT: production
  SENTRY_RELEASE_SHA: ${{ github.sha }}
```

The release tag sent to Sentry is `jarvis-seo@<sha-short>` (first 7 chars
of the commit SHA).

### Local development

Sentry is disabled locally by default because `SENTRY_ENVIRONMENT` is
unset (defaults to `development`), which short-circuits the init.

To test Sentry locally (optional):
```sh
export SENTRY_DSN_SEO=https://xxx@oxxx.ingest.de.sentry.io/xxx
export SENTRY_ENVIRONMENT=staging
node scripts/workflow-daily.js --dry-run
```

## Usage in script code

### Init (required at the top of each entrypoint)

```js
const sentry = require('./lib/sentry');
sentry.init({ script: 'workflow-daily' });
```

The init is idempotent - calling it multiple times is safe (useful when
`seo-publish-article.js` is imported as a module AND run as a script).

### Fatal error handler (required at bottom of each entrypoint)

```js
main().catch((err) => sentry.fatal(err));
```

This replaces the previous `{ console.error(...); process.exit(1); }` pattern.
`fatal()` prints the error locally, captures it in Sentry, flushes the
buffer with a 2s timeout, then calls `process.exit(1)`.

### Manual capture (inside the script)

```js
try {
  await publishToSanity(...);
} catch (err) {
  sentry.captureException(err, {
    tags: { site: 'ag', lang: 'fr' },
    extra: { keyword: 'prevoyance-lpp' }
  });
  // continue or rethrow as needed
}
```

### Breadcrumbs (attach context to future errors)

```js
sentry.addBreadcrumb({
  category: 'sanity',
  message: 'Publishing article to Sanity',
  level: 'info',
  data: { site: 'ag', docId: 'article-xxx' }
});
```

## Testing the integration

After the PR is merged and `SENTRY_DSN_SEO` is configured in GitHub Secrets:

1. Trigger a manual run of `jarvis-on-demand.yml` with a test task_id
2. Intentionally cause a failure (e.g. invalid task_id) to trigger fatal()
3. Check Sentry UI (project `jarvis-seo`) - the error should appear with:
   - Environment: production
   - Release: jarvis-seo@<sha-short>
   - Tag: script=workflow-single-task
   - Full stack trace

## Known limitations

- Performance traces are disabled (`tracesSampleRate: 0`) - error-only for PR 0.1b
- HTTP integrations are stripped (no auto-instrumentation of fetch/http
  requests) to keep the script lightweight
- No user context is attached (scripts run unauthenticated)
- `console.log/warn/error` are NOT captured as breadcrumbs (would be too
  noisy given the verbose logging pattern in Jarvis-SEO scripts)
