// supabase/functions/semrush-fetch-cron/handler.ts
//
// Skeleton placeholder Edge Function — Phase 3 SEO Reports SEMrush PR 1 SEO.
// Full implementation PR 2 Calendar (cohérent D4 SEALED v2 ADR D-2026-05-06-sprint-m3-scope-locked).
//
// Cf ADR sealed `D-2026-05-06-sprint-m3-scope-locked` (vault HEAD `29b90fe`)
//    Brief Cowork `brief-PR-1-SEO-phase-3-helpers-and-cron-foundation.md`
//
// Ce skeleton couvre :
//   - INTERNAL_FUNCTION_SECRET Bearer auth (cohérent audit-log-cron-monitor pattern)
//   - Sentry init + scope isolation withScope per invocation + flush(2000) avant return
//   - Smoke marker table Option ε.2 staging-only check (placeholder PR 1, full RPC PR 2)
//   - Cron schedule placeholder (full pg_cron registration migration #49 PR 2 Calendar)
//   - PLACEHOLDER fetchSemrushData call (full implementation PR 2 utilisant _shared/semrush.ts)
//
// Future PR 2 Calendar :
//   - Full fetchSemrushData implementation utilisant _shared/semrush.ts helper (rateLimitedSemrushGet + parseCSV + validate)
//   - Storage upsert idempotent reports_organic_keywords + reports_traffic_overview + reports_backlinks_summary + reports_position_tracking
//   - Cron schedules registration migration #49 (daily 6am UTC + weekly mardi 6am UTC)

import { captureWithScope, flushSentry, initSentry } from '../_shared/sentry.ts';

const INTERNAL_FUNCTION_SECRET_ENV = 'INTERNAL_FUNCTION_SECRET';

type ResponseBody = {
  ok: boolean;
  forwarded?: number;
  window_minutes?: number;
  error?: string;
  env_marker?: string | null;
};

function jsonResponse(status: number, body: ResponseBody): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Verify Bearer Authorization header against INTERNAL_FUNCTION_SECRET env var.
 * Returns true if valid, false otherwise (fail-closed if env not set).
 */
function verifyBearerAuth(req: Request): boolean {
  const expectedSecret = Deno.env.get(INTERNAL_FUNCTION_SECRET_ENV);
  if (!expectedSecret) return false;

  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  const providedToken = authHeader.slice('Bearer '.length);
  return providedToken === expectedSecret;
}

/**
 * Smoke check marker table Option ε.2 (cohérent Sprint M2 cumul Item 3 S3.5).
 * Returns 'staging' if marker table exists + row 'staging' present.
 * Returns null if marker table absent (likely prod environment) OR not staging.
 *
 * PR 1 placeholder retourne null (full RPC wrapper public marker check PR 2 Calendar).
 * Pattern attendu PR 2 :
 *   const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
 *   const { data, error } = await supabase.rpc('get_migration_env');
 *   if (error || !data) return null;
 *   return data; // 'staging' | null
 */
async function checkEnvMarker(): Promise<string | null> {
  // PLACEHOLDER PR 1 — full RPC wrapper implementation PR 2 Calendar
  return null;
}

export async function handleSemrushFetchCron(req: Request): Promise<Response> {
  if (!verifyBearerAuth(req)) {
    return jsonResponse(401, { ok: false, error: 'Unauthorized' });
  }

  initSentry();

  try {
    const envMarker = await checkEnvMarker();

    if (envMarker !== 'staging') {
      // Prod environment OR marker absent → graceful no-op (skeleton placeholder)
      return jsonResponse(200, {
        ok: true,
        forwarded: 0,
        window_minutes: 0,
        env_marker: envMarker,
      });
    }

    // PLACEHOLDER fetchSemrushData call — full implementation PR 2 Calendar
    //
    // Pattern attendu PR 2 :
    //   import { fetchSemrushData } from '../_shared/semrush.ts';  // full helper PR 2 extension
    //   const result = await fetchSemrushData('domain_organic', { domain: 'fiduciaire-genevoise.ch', database: 'ch' });
    //   await persistReports(result);
    //
    // PR 1 skeleton retourne 200 OK staging marker present + 0 forwarded (placeholder).
    return jsonResponse(200, {
      ok: true,
      forwarded: 0,
      window_minutes: 0,
      env_marker: 'staging',
    });
  } catch (err: unknown) {
    captureWithScope(err instanceof Error ? err : new Error(String(err)), {
      fingerprint: ['semrush-fetch-cron', 'handler-error'],
      tags: { edge_function: 'semrush-fetch-cron', phase: 'phase-3' },
      contexts: {
        request: { method: req.method, url: req.url },
      },
    });

    return jsonResponse(500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Flush Sentry events avant return (caveat critique Deno SDK 2026)
    await flushSentry(2000);
  }
}
