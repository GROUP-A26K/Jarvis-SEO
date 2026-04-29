// Log-only persister stub — skeleton-only, no DB writes.
// SWAP E6 (commit 5) : real implementation will UPSERT daily rows into
// metrics_traffic HASH-partitioned table per D-2026-04-27-ga4-storage,
// with idempotent ON CONFLICT (client_id, site_slug, date, dimension_type, dimension_key).

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

export const defaultMetricsPersister: MetricsPersister = {
  persist(payload: PersistPayload): Promise<PersistResult> {
    const overallRows = payload.sites.reduce((sum, s) => sum + s.daily_overall.length, 0);
    const pageRows = payload.sites.reduce((sum, s) => sum + s.daily_per_page.length, 0);
    const total = overallRows + pageRows;

    console.log(
      `[metrics-persister stub] would persist ${total} daily rows ` +
        `(${overallRows} overall + ${pageRows} per_page) ` +
        `for client ${payload.client_id} ` +
        `over period ${payload.period.start} → ${payload.period.end}`,
    );

    return Promise.resolve({
      ok: true,
      rows_persisted: total,
      errors: [],
    });
  },
};
