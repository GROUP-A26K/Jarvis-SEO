// Real GA4 Data API client — daily granularity per E6 swap.
// Service account credentials lus depuis Deno.env GCP_GA4_A26K_KEY (JSON sérialisé).
// Property IDs résolus via sites/ga4-properties.json côté handler (non utilisé ici).
// Threshold logic vit côté handler (calcul sur agrégat per-page, pas par jour).

import { BetaAnalyticsDataClient } from '@google-analytics/data';
import type { DailyOverall, DailyPerPage, Period } from './schema.ts';

export interface GA4Client {
  fetchOverall(propertyId: string, period: Period): Promise<DailyOverall[]>;
  fetchPerPage(
    propertyId: string,
    period: Period,
    overallByDate: Record<string, number>,
  ): Promise<DailyPerPage[]>;
}

// GA4 dimension `date` retourne YYYYMMDD compact ; on convertit en ISO YYYY-MM-DD
// pour cohérence avec DateStringSchema et metrics_traffic.date (DATE Postgres).
function ga4DateToIso(ga4Date: string): string {
  if (ga4Date.length !== 8) return '';
  return `${ga4Date.slice(0, 4)}-${ga4Date.slice(4, 6)}-${ga4Date.slice(6, 8)}`;
}

// Period.start/end sont ISO datetime offset (request-validated par Zod).
// slice(0,10) extrait YYYY-MM-DD que GA4 Data API accepte directement.
function toGa4DateRange(period: Period): { startDate: string; endDate: string } {
  return {
    startDate: period.start.slice(0, 10),
    endDate: period.end.slice(0, 10),
  };
}

let cachedClient: BetaAnalyticsDataClient | null = null;
function getClient(): BetaAnalyticsDataClient {
  if (cachedClient) return cachedClient;
  const keyJson = Deno.env.get('GCP_GA4_A26K_KEY');
  if (!keyJson) {
    throw new Error('GCP_GA4_A26K_KEY env variable is required for GA4 Data API calls');
  }
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(keyJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`GCP_GA4_A26K_KEY is not valid JSON: ${msg}`);
  }
  cachedClient = new BetaAnalyticsDataClient({ credentials });
  return cachedClient;
}

// GA4 Data API retourne tous les metricValues en string. parseInt safe pour
// counts entiers ; Number safe pour engagement_rate float ; clamp [0,1] par
// défense côté handler/schema (GA4 garantit déjà ces bornes mais on ne fait
// pas confiance aux APIs externes).
function safeInt(value: string | null | undefined): number {
  if (!value) return 0;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function safeFloat(value: string | null | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export const defaultGa4Client: GA4Client = {
  async fetchOverall(propertyId: string, period: Period): Promise<DailyOverall[]> {
    const client = getClient();
    const dateRange = toGa4DateRange(period);
    const [response] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [dateRange],
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'engagementRate' },
        { name: 'keyEvents' },
      ],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    });
    const rows = response.rows ?? [];
    return rows
      .map((row) => {
        const date = ga4DateToIso(row.dimensionValues?.[0]?.value ?? '');
        if (!date) return null;
        return {
          date,
          sessions: safeInt(row.metricValues?.[0]?.value),
          users: safeInt(row.metricValues?.[1]?.value),
          engagement_rate: clampUnit(safeFloat(row.metricValues?.[2]?.value)),
          key_events: safeInt(row.metricValues?.[3]?.value),
        };
      })
      .filter((d): d is DailyOverall => d !== null);
  },

  async fetchPerPage(
    propertyId: string,
    period: Period,
    _overallByDate: Record<string, number>,
  ): Promise<DailyPerPage[]> {
    // overallByDate non utilisé ici : real GA4 nous donne directement les sessions
    // par page sans avoir besoin du contexte overall (Q3 threshold est calculé
    // côté handler post-aggregation). Param gardé pour cohérence interface
    // (mocks tests s'en servent pour fake threshold_match déterministe).
    const client = getClient();
    const dateRange = toGa4DateRange(period);
    const [response] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [dateRange],
      dimensions: [{ name: 'date' }, { name: 'pagePath' }],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'engagementRate' },
        { name: 'keyEvents' },
      ],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 10000, // safety cap : Q3 attend ~350 rows/run après filter handler.
    });
    const rows = response.rows ?? [];
    return rows
      .map((row) => {
        const date = ga4DateToIso(row.dimensionValues?.[0]?.value ?? '');
        const page_path = row.dimensionValues?.[1]?.value ?? '';
        if (!date || !page_path) return null;
        return {
          date,
          page_path,
          sessions: safeInt(row.metricValues?.[0]?.value),
          users: safeInt(row.metricValues?.[1]?.value),
          engagement_rate: clampUnit(safeFloat(row.metricValues?.[2]?.value)),
          key_events: safeInt(row.metricValues?.[3]?.value),
        };
      })
      .filter((d): d is DailyPerPage => d !== null);
  },
};
