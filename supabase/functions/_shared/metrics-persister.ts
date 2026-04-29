// Real metrics persister — UPSERT daily rows dans metrics_traffic.
// HASH-partitioned table (D-2026-04-27-ga4-storage), service_role bypasse RLS,
// ON CONFLICT idempotent sur unique index (client_id, site_slug, date,
// dimension_type, dimension_key) NULLS NOT DISTINCT — cron daily safe re-run.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { DailyOverall, DailyPerPage, Period } from './schema.ts';

export type PersistSite = {
  slug: string;
  property_id: string;
  daily_overall: DailyOverall[];
  daily_per_page: DailyPerPage[];
};

export type PersistPayload = {
  client_id: string;
  fetched_at: string;
  period: Period;
  sites: PersistSite[];
};

export type PersistResult = {
  ok: boolean;
  rows_persisted: number;
  errors: string[];
};

export interface MetricsPersister {
  persist(payload: PersistPayload): Promise<PersistResult>;
}

type MetricRow = {
  client_id: string;
  site_slug: string;
  date: string;
  dimension_type: 'overall' | 'per_page';
  dimension_key: string | null;
  sessions: number;
  users: number;
  engagement_rate: number;
  key_events: number;
};

const ON_CONFLICT = 'client_id,site_slug,date,dimension_type,dimension_key';

// Batch size : Postgres parameter limit ~65k. Avec 9 cols/row, 500 rows = 4500
// params, marge confortable. Volumétrie attendue ~385 rows/run (5 sites × 7j × 11p)
// donc 1 batch suffit en pratique mais batching protège runs sur fenêtres longues.
const BATCH_SIZE = 500;

let cachedSupabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (cachedSupabase) return cachedSupabase;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env variables required for metrics persistence',
    );
  }
  cachedSupabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedSupabase;
}

// dimension_type='overall' → dimension_key NULL (CHECK metrics_traffic_dim_key_consistency).
// dimension_type='per_page' → dimension_key = page_path (NOT NULL).
function buildRows(payload: PersistPayload): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const site of payload.sites) {
    for (const d of site.daily_overall) {
      rows.push({
        client_id: payload.client_id,
        site_slug: site.slug,
        date: d.date,
        dimension_type: 'overall',
        dimension_key: null,
        sessions: d.sessions,
        users: d.users,
        engagement_rate: d.engagement_rate,
        key_events: d.key_events,
      });
    }
    for (const d of site.daily_per_page) {
      rows.push({
        client_id: payload.client_id,
        site_slug: site.slug,
        date: d.date,
        dimension_type: 'per_page',
        dimension_key: d.page_path,
        sessions: d.sessions,
        users: d.users,
        engagement_rate: d.engagement_rate,
        key_events: d.key_events,
      });
    }
  }
  return rows;
}

export const defaultMetricsPersister: MetricsPersister = {
  async persist(payload: PersistPayload): Promise<PersistResult> {
    const rows = buildRows(payload);
    if (rows.length === 0) {
      return { ok: true, rows_persisted: 0, errors: [] };
    }
    const supabase = getSupabase();
    const errors: string[] = [];
    let rows_persisted = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from('metrics_traffic').upsert(batch, {
        onConflict: ON_CONFLICT,
        ignoreDuplicates: false,
      });
      if (error) {
        errors.push(
          `batch ${Math.floor(i / BATCH_SIZE)} (${batch.length} rows): ${error.message}`,
        );
      } else {
        rows_persisted += batch.length;
      }
    }

    return {
      ok: errors.length === 0,
      rows_persisted,
      errors,
    };
  },
};
