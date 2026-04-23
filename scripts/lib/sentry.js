/**
 * Jarvis-SEO - Sentry error monitoring for Node.js scripts.
 *
 * Pipeline scripts are ephemeral (they exit when work is done), so we MUST
 * flush Sentry buffer before process.exit() or events are lost.
 *
 * Strategy (PR 0.1b):
 * - Error monitoring only (no Performance, no Profiling)
 * - Environments: production | development
 * - Release tracking: jarvis-seo@<sha-short>
 * - PII disabled (sendDefaultPii: false)
 * - Idempotent init: safe to call multiple times
 * - Disabled locally unless SENTRY_DSN_SEO is set
 *
 * Usage in each entrypoint:
 *   const sentry = require('./lib/sentry');
 *   sentry.init({ script: 'workflow-daily' });
 *
 * At end of main():
 *   main().catch((err) => sentry.fatal(err));
 *
 * Manual capture:
 *   sentry.captureException(err, { tags: { site: 'ag' } });
 */

let _initialized = false;
let _Sentry = null;
let _enabled = false;

function init(opts) {
  opts = opts || {};
  if (_initialized) return;
  _initialized = true;

  const dsn = process.env.SENTRY_DSN_SEO;
  const environment = process.env.SENTRY_ENVIRONMENT || 'development';

  if (!dsn) return;
  if (environment === 'development') return;

  _Sentry = require('@sentry/node');

  const sha = process.env.SENTRY_RELEASE_SHA || process.env.GITHUB_SHA;
  const release = sha ? 'jarvis-seo@' + sha.slice(0, 7) : undefined;

  _Sentry.init({
    dsn: dsn,
    environment: environment,
    release: release,
    sendDefaultPii: false,
    sampleRate: 1.0,
    tracesSampleRate: 0,
    integrations: function (defaults) {
      const strip = [
        'Http',
        'NodeFetch',
        'Express',
        'Fastify',
        'Koa',
        'Connect',
        'GraphQL',
        'Mongo',
        'Mongoose',
        'Mysql',
        'Mysql2',
        'Postgres',
        'Prisma',
        'Redis',
        'Anr',
        'ProcessSession',
      ];
      return defaults.filter(function (i) {
        return strip.indexOf(i.name) === -1;
      });
    },
    beforeSend: function (event) {
      if (event.request && event.request.headers) {
        for (const key of Object.keys(event.request.headers)) {
          if (/authorization|cookie|token|secret|key/i.test(key)) {
            event.request.headers[key] = '[Filtered]';
          }
        }
      }
      return event;
    },
  });

  if (opts.script) {
    _Sentry.setTag('script', opts.script);
  }

  _enabled = true;
}

function isEnabled() {
  return _enabled;
}

function captureException(err, context) {
  if (!_enabled || !_Sentry) return;
  context = context || {};
  _Sentry.withScope(function (scope) {
    if (context.tags) {
      for (const k of Object.keys(context.tags)) {
        scope.setTag(k, context.tags[k]);
      }
    }
    if (context.extra) {
      for (const k of Object.keys(context.extra)) {
        scope.setExtra(k, context.extra[k]);
      }
    }
    if (context.level) {
      scope.setLevel(context.level);
    }
    _Sentry.captureException(err);
  });
}

function addBreadcrumb(breadcrumb) {
  if (!_enabled || !_Sentry) return;
  _Sentry.addBreadcrumb(breadcrumb);
}

async function flush(timeoutMs) {
  if (!_enabled || !_Sentry) return true;
  if (typeof timeoutMs !== 'number') timeoutMs = 2000;
  try {
    return await _Sentry.flush(timeoutMs);
  } catch (e) {
    return false;
  }
}

async function fatal(err) {
  console.error('\n! Fatal: ' + (err && err.message ? err.message : err));
  if (err && err.stack) console.error(err.stack);
  captureException(err, { level: 'fatal' });
  await flush(2000);
  process.exit(1);
}

module.exports = {
  init: init,
  isEnabled: isEnabled,
  captureException: captureException,
  addBreadcrumb: addBreadcrumb,
  flush: flush,
  fatal: fatal,
};
