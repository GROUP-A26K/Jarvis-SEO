// GA4 fetch handler — DI-first, mocks-first skeleton.
// Contract per D-2026-04-27-ga4-ui ; env validation per spec M11 (graceful).
// SWAP E6: ga4Client and persister will be replaced with real impls.

import {
  GA4FetchRequestSchema,
  GA4FetchResponseSchema,
  type Aggregates,
  type DailyOverall,
  type DailyPerPage,
  type ErrorEntry,
  type GA4FetchResponse,
  type OverallMetrics,
  type PageMetrics,
  type SiteMetrics,
} from '../_shared/schema.ts';
import { defaultGa4Client, type GA4Client } from '../_shared/ga4-client.ts';
import {
  defaultMetricsPersister,
  type MetricsPersister,
  type PersistPayload,
  type PersistSite,
} from '../_shared/metrics-persister.ts';
import { loadSiteMapping, type SiteEntry } from '../_shared/site-mapping.ts';

// Path resolution skeleton: import.meta.url + ../../../sites/...
// Suffisant pour deno test/run local. Au swap E6, le déploiement Supabase
// Edge devra trancher : (a) env var override, (b) file colocation
// supabase/functions/_shared/, ou (c) fetch depuis URL public. Décision
// déférée à la PR swap E6 selon les constraints réelles du runtime
// Supabase Edge constatées au smoke test E5.
const DEFAULT_SITE_MAPPING_PATH = new URL('../../../sites/ga4-properties.json', import.meta.url)
  .pathname;

const EMPTY_AGGREGATES: Aggregates = {
  total_sessions_all_sites: 0,
  total_users_all_sites: 0,
  sites_with_data: 0,
  sites_with_errors: 0,
};

function nowIso(): string {
  return new Date().toISOString();
}

// Placeholder period for early-error responses where request.period is unknown.
// Zero-duration (start=end=today YYYY-MM-DD) — schema requires date-only per E6 swap mocks→real (commit 3ff3dff).
function placeholderPeriod(): { start: string; end: string } {
  const today = nowIso().slice(0, 10);
  return { start: today, end: today };
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Aggregate daily overalls into a single OverallMetrics for the period.
// engagement_rate uses weighted average by sessions : Σ(er_d × sessions_d) / Σ sessions_d.
// Rationale : un jour à 1000 sessions @ 0.5 ER doit peser plus qu'un jour à
// 10 sessions @ 0.9 ER. Simple mean (Σer/N) inflate ER sur jours faible-volume.
// Équivalent à l'agrégat natif GA4 sans dimension date.
function aggregateOverall(daily: DailyOverall[]): OverallMetrics | null {
  if (daily.length === 0) return null;
  const sessions = daily.reduce((s, d) => s + d.sessions, 0);
  const users = daily.reduce((s, d) => s + d.users, 0);
  const key_events = daily.reduce((s, d) => s + d.key_events, 0);
  const erWeightedSum = daily.reduce((s, d) => s + d.engagement_rate * d.sessions, 0);
  const engagement_rate = sessions > 0 ? erWeightedSum / sessions : 0;
  return { sessions, users, engagement_rate, key_events };
}

// Aggregate daily per-page rows by page_path, apply Q3 dynamic threshold
// per D-2026-04-27-ga4-granularity (page kept if sessions/overall > 1% OR
// sessions > 100, computed on the PERIOD aggregate — pas par jour individuel).
// Returns aggregated PageMetrics + set of kept paths so caller can filter
// daily rows persisted (toutes les daily rows d'une page qualifiée sont stockées,
// cohérence des séries temporelles).
function aggregateAndFilterPerPage(
  daily: DailyPerPage[],
  overallSessions: number,
): { aggregated: PageMetrics[]; keptPaths: Set<string> } {
  const byPath = new Map<string, DailyPerPage[]>();
  for (const row of daily) {
    const list = byPath.get(row.page_path) ?? [];
    list.push(row);
    byPath.set(row.page_path, list);
  }
  const aggregated: PageMetrics[] = [];
  const keptPaths = new Set<string>();
  for (const [page_path, rows] of byPath.entries()) {
    const sessions = rows.reduce((s, r) => s + r.sessions, 0);
    const users = rows.reduce((s, r) => s + r.users, 0);
    const key_events = rows.reduce((s, r) => s + r.key_events, 0);
    const erWeightedSum = rows.reduce((s, r) => s + r.engagement_rate * r.sessions, 0);
    const engagement_rate = sessions > 0 ? erWeightedSum / sessions : 0;
    const pctMatch = overallSessions > 0 && sessions / overallSessions > 0.01;
    const absMatch = sessions > 100;
    if (!pctMatch && !absMatch) continue;
    let threshold_match: PageMetrics['threshold_match'];
    if (pctMatch && absMatch) threshold_match = 'both';
    else if (pctMatch) threshold_match = 'pct_traffic';
    else threshold_match = 'absolute_volume';
    aggregated.push({
      page_path,
      sessions,
      users,
      engagement_rate,
      key_events,
      threshold_match,
    });
    keptPaths.add(page_path);
  }
  return { aggregated, keptPaths };
}

function deriveStatus(sites: SiteMetrics[], errors: ErrorEntry[]): GA4FetchResponse['status'] {
  if (sites.length === 0) return 'error';
  const sitesWithData = sites.filter((s) => s.overall !== null).length;
  if (sitesWithData === 0) return 'error';
  if (sitesWithData === sites.length && errors.length === 0) return 'ok';
  return 'partial';
}

function deriveAggregates(sites: SiteMetrics[], errors: ErrorEntry[]): Aggregates {
  return {
    total_sessions_all_sites: sites.reduce((acc, s) => acc + (s.overall?.sessions ?? 0), 0),
    total_users_all_sites: sites.reduce((acc, s) => acc + (s.overall?.users ?? 0), 0),
    sites_with_data: sites.filter((s) => s.overall !== null).length,
    sites_with_errors: errors.filter((e) => e.site_slug !== undefined).length,
  };
}

function jsonResponse(httpStatus: number, body: GA4FetchResponse): Response {
  return new Response(JSON.stringify(body), {
    status: httpStatus,
    headers: { 'content-type': 'application/json' },
  });
}

function buildEarlyErrorResponse(
  scope: ErrorEntry['scope'],
  message: string,
  clientId: string,
  period: { start: string; end: string },
): GA4FetchResponse {
  return {
    status: 'error',
    data: { sites: [], aggregates: EMPTY_AGGREGATES },
    errors: [{ scope, message, caught_at: nowIso() }],
    meta: {
      fetched_at: nowIso(),
      client_id: clientId,
      period,
    },
  };
}

export async function handleFetch(
  req: Request,
  deps?: {
    ga4Client?: GA4Client;
    persister?: MetricsPersister;
    siteMappingPath?: string;
  },
): Promise<Response> {
  const ga4Client = deps?.ga4Client ?? defaultGa4Client;
  const persister = deps?.persister ?? defaultMetricsPersister;
  const siteMappingPath = deps?.siteMappingPath ?? DEFAULT_SITE_MAPPING_PATH;

  // Step 1: ENV CHECK GRACIEUX (M11)
  const clientId = Deno.env.get('A26K_CLIENT_ID');
  if (!clientId) {
    const body = buildEarlyErrorResponse(
      'unknown',
      'A26K_CLIENT_ID env variable is required but undefined',
      '',
      placeholderPeriod(),
    );
    return jsonResponse(500, GA4FetchResponseSchema.parse(body));
  }

  // Step 2: METHOD CHECK
  if (req.method !== 'POST') {
    const body = buildEarlyErrorResponse(
      'schema',
      `Method ${req.method} not allowed; expected POST`,
      clientId,
      placeholderPeriod(),
    );
    return jsonResponse(405, GA4FetchResponseSchema.parse(body));
  }

  // Step 3: PARSE & VALIDATE REQUEST BODY
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch (err) {
    const body = buildEarlyErrorResponse(
      'schema',
      `Invalid JSON body: ${getErrorMessage(err)}`,
      clientId,
      placeholderPeriod(),
    );
    return jsonResponse(400, GA4FetchResponseSchema.parse(body));
  }

  const requestParsed = GA4FetchRequestSchema.safeParse(rawBody);
  if (!requestParsed.success) {
    const body = buildEarlyErrorResponse(
      'schema',
      `Invalid request: ${requestParsed.error.message}`,
      clientId,
      placeholderPeriod(),
    );
    return jsonResponse(400, GA4FetchResponseSchema.parse(body));
  }
  const request = requestParsed.data;

  // Step 4: LOAD SITE MAPPING
  let mapping: SiteEntry[];
  try {
    mapping = await loadSiteMapping(siteMappingPath);
  } catch (err) {
    const body = buildEarlyErrorResponse(
      'unknown',
      `Failed to load site mapping: ${getErrorMessage(err)}`,
      clientId,
      request.period,
    );
    return jsonResponse(500, GA4FetchResponseSchema.parse(body));
  }

  const requestedSlugs = request.sites;
  const filteredMapping = requestedSlugs
    ? mapping.filter((m) => requestedSlugs.includes(m.slug))
    : mapping;

  if (filteredMapping.length === 0) {
    const body = buildEarlyErrorResponse(
      'schema',
      'No matching sites for requested slugs',
      clientId,
      request.period,
    );
    return jsonResponse(400, GA4FetchResponseSchema.parse(body));
  }

  // Step 5: FETCH PER SITE (sequential — parallelization deferred)
  // Daily granularity : ga4Client retourne DailyOverall[] et DailyPerPage[]
  // sur la période. Handler agrège pour la JSON response (contrat Q2)
  // et stash daily-data filtered pour le persister (Q3 filter binaire par page).
  const sites: SiteMetrics[] = [];
  const errors: ErrorEntry[] = [];
  const persistSites: PersistSite[] = [];
  for (const entry of filteredMapping) {
    let overall: OverallMetrics | null = null;
    let per_page: PageMetrics[] = [];
    let dailyOverallSite: DailyOverall[] = [];
    let dailyPerPageFiltered: DailyPerPage[] = [];
    try {
      const dailyOverall = await ga4Client.fetchOverall(entry.propertyId, request.period);
      const overallByDate = Object.fromEntries(dailyOverall.map((d) => [d.date, d.sessions]));
      const dailyPerPage = await ga4Client.fetchPerPage(
        entry.propertyId,
        request.period,
        overallByDate,
      );
      overall = aggregateOverall(dailyOverall);
      const { aggregated, keptPaths } = aggregateAndFilterPerPage(
        dailyPerPage,
        overall?.sessions ?? 0,
      );
      per_page = aggregated;
      dailyOverallSite = dailyOverall;
      dailyPerPageFiltered = dailyPerPage.filter((d) => keptPaths.has(d.page_path));
    } catch (err) {
      errors.push({
        site_slug: entry.slug,
        scope: 'unknown',
        message: getErrorMessage(err),
        property_id: entry.propertyId,
        caught_at: nowIso(),
      });
    }
    sites.push({
      slug: entry.slug,
      property_id: entry.propertyId,
      overall,
      per_page,
    });
    persistSites.push({
      slug: entry.slug,
      property_id: entry.propertyId,
      daily_overall: dailyOverallSite,
      daily_per_page: dailyPerPageFiltered,
    });
  }

  // Step 6: PERSIST (daily rows, idempotent ON CONFLICT côté impl real commit 5)
  const fetchedAt = nowIso();
  const payload: PersistPayload = {
    client_id: clientId,
    fetched_at: fetchedAt,
    period: request.period,
    sites: persistSites,
  };
  try {
    const persistResult = await persister.persist(payload);
    if (!persistResult.ok) {
      errors.push({
        scope: 'unknown',
        message: `metrics persistence failed: ${persistResult.errors.join('; ')}`,
        caught_at: nowIso(),
      });
    }
  } catch (err) {
    errors.push({
      scope: 'unknown',
      message: `metrics persistence failed: ${getErrorMessage(err)}`,
      caught_at: nowIso(),
    });
  }

  // Step 7: BUILD RESPONSE
  const status = deriveStatus(sites, errors);
  const aggregates = deriveAggregates(sites, errors);
  const response: GA4FetchResponse = {
    status,
    data: { sites, aggregates },
    errors,
    meta: {
      fetched_at: fetchedAt,
      client_id: clientId,
      period: request.period,
    },
  };

  // Validate before return (defense in depth — handler bug shows up here)
  const validated = GA4FetchResponseSchema.parse(response);
  const httpStatus = status === 'error' ? 500 : 200;
  return jsonResponse(httpStatus, validated);
}
