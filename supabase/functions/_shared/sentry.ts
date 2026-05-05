// supabase/functions/_shared/sentry.ts
import * as Sentry from 'npm:@sentry/deno';

let initialized = false;

export function initSentry(): void {
  if (initialized) return;

  const dsn = Deno.env.get('SENTRY_DSN');
  if (!dsn) {
    console.warn('SENTRY_DSN not set — Sentry disabled');
    return;
  }

  Sentry.init({
    dsn,
    environment: Deno.env.get('SB_ENV') ?? 'production',
    defaultIntegrations: false,
    tracesSampleRate: 0.0, // pas de tracing pour Edge Functions monitoring (cost optim)
    release: Deno.env.get('SENTRY_RELEASE') ?? 'jarvis-calendar@unknown',
  });

  initialized = true;
}

/**
 * Capture une exception dans un scope isolé (manual scope isolation per Deno SDK caveat).
 * Toujours utiliser cette fonction au lieu de Sentry.captureException direct.
 * Cf ADR D-2026-05-05-sentry-edge-function-audit-monitor § Couche 4 caveat 1
 * (Sentry Deno SDK ne supporte pas Deno.serve auto-instrumentation, breadcrumbs partagés cross-requests sans withScope).
 */
export function captureWithScope(
  err: Error,
  context: {
    fingerprint: string[];
    tags?: Record<string, string>;
    contexts?: Record<string, Record<string, unknown>>;
  },
): void {
  Sentry.withScope((scope) => {
    scope.setFingerprint(context.fingerprint);
    if (context.tags) {
      for (const [key, value] of Object.entries(context.tags)) {
        scope.setTag(key, value);
      }
    }
    if (context.contexts) {
      for (const [key, value] of Object.entries(context.contexts)) {
        scope.setContext(key, value);
      }
    }
    Sentry.captureException(err);
  });
}

/**
 * Flush events avant runtime close (caveat critique Deno SDK).
 * À appeler systématiquement avant return Response sinon events perdus.
 * Cf ADR D-2026-05-05-sentry-edge-function-audit-monitor § Couche 4 caveat 2.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  await Sentry.flush(timeoutMs);
}
