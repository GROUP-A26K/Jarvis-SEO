// Log-only persister stub — skeleton-only, no DB writes.
// SWAP E6: real implementation will INSERT into metrics_traffic
// HASH-partitioned table per D-2026-04-27-ga4-storage, with RLS
// enforcement on client_id per D-2026-04-27-ga4-multi-tenant-timing.

import type { OverallMetrics, PageMetrics } from "./schema.ts";

export type PersistPayload = {
  client_id: string;
  fetched_at: string;
  period: { start: string; end: string };
  sites: Array<{
    slug: string;
    property_id: string;
    overall: OverallMetrics | null;
    per_page: PageMetrics[];
  }>;
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
    const overallRows = payload.sites.filter((s) => s.overall !== null).length;
    const pageRows = payload.sites.reduce(
      (sum, s) => sum + s.per_page.length,
      0,
    );
    const total = overallRows + pageRows;

    console.log(
      `[metrics-persister stub] would persist ${total} rows ` +
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
