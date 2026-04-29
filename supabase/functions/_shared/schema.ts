// per M7 spec, Zod pinned at v3.22.4.
// Canal: npm: via deno.json import map — Supabase Edge Functions standard pour Deno 2.x.
// Reference: https://supabase.com/docs/guides/functions/dependencies
import { z } from 'zod';

// --- Period (request window) ---

export const PeriodSchema = z.object({
  start: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  end: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
});
export type Period = z.infer<typeof PeriodSchema>;

// Date format YYYY-MM-DD : colonne metrics_traffic.date (DATE Postgres) +
// retour daily du GA4 client (post-conversion depuis GA4 dimension date YYYYMMDD).
export const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');
export type DateString = z.infer<typeof DateStringSchema>;

// --- Component schemas (response payload) ---

export const OverallMetricsSchema = z.object({
  sessions: z.number().int().nonnegative(),
  users: z.number().int().nonnegative(),
  engagement_rate: z.number().min(0).max(1),
  key_events: z.number().int().nonnegative(),
});
export type OverallMetrics = z.infer<typeof OverallMetricsSchema>;

export const PageMetricsSchema = OverallMetricsSchema.extend({
  page_path: z.string().min(1),
  threshold_match: z.enum(['pct_traffic', 'absolute_volume', 'both']),
});
export type PageMetrics = z.infer<typeof PageMetricsSchema>;

// --- Daily granularity (storage + GA4 client return shape) ---
// DailyOverall : 1 row par jour pour un site (dimension_type='overall' en DB).
export const DailyOverallSchema = OverallMetricsSchema.extend({
  date: DateStringSchema,
});
export type DailyOverall = z.infer<typeof DailyOverallSchema>;

// DailyPerPage : 1 row par jour×page (dimension_type='per_page' en DB, dimension_key=page_path).
// PAS de threshold_match — calculé sur l'agrégat per-page côté handler
// (Q3 dynamique : pct_traffic > 1% OR absolute > 100 sessions sur la PÉRIODE,
// pas par jour individuel — sinon trop de bruit).
export const DailyPerPageSchema = OverallMetricsSchema.extend({
  date: DateStringSchema,
  page_path: z.string().min(1),
});
export type DailyPerPage = z.infer<typeof DailyPerPageSchema>;

// M9: slug lowercase URL-safe per D-2026-04-28-site-naming-convention.
// M1: property_id 8-12 digits (GA4 vintages varient, marge volontaire).
export const SiteMetricsSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(20)
    .regex(
      /^[a-z0-9-]+$/,
      'slug must be lowercase URL-safe per D-2026-04-28-site-naming-convention',
    ),
  property_id: z.string().regex(/^\d{8,12}$/, 'GA4 property_id must be 8-12 digits'),
  overall: OverallMetricsSchema.nullable(),
  per_page: z.array(PageMetricsSchema),
});
export type SiteMetrics = z.infer<typeof SiteMetricsSchema>;

export const AggregatesSchema = z.object({
  total_sessions_all_sites: z.number().int().nonnegative(),
  total_users_all_sites: z.number().int().nonnegative(),
  sites_with_data: z.number().int().nonnegative(),
  sites_with_errors: z.number().int().nonnegative(),
});
export type Aggregates = z.infer<typeof AggregatesSchema>;

export const ErrorEntrySchema = z.object({
  site_slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  scope: z.enum(['auth', 'quota', 'network', 'schema', 'unknown']),
  message: z.string().min(1),
  property_id: z
    .string()
    .regex(/^\d{8,12}$/)
    .optional(),
  caught_at: z.string().datetime({ offset: true }),
});
export type ErrorEntry = z.infer<typeof ErrorEntrySchema>;

// --- Top-level response schema (canonical contract per D-2026-04-27-ga4-ui) ---

export const GA4FetchResponseSchema = z.object({
  status: z.enum(['ok', 'partial', 'error']),
  data: z.object({
    sites: z.array(SiteMetricsSchema),
    aggregates: AggregatesSchema,
  }),
  errors: z.array(ErrorEntrySchema),
  meta: z.object({
    fetched_at: z.string().datetime({ offset: true }),
    client_id: z.string(),
    period: z.object({
      start: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
      end: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
    }),
  }),
});
export type GA4FetchResponse = z.infer<typeof GA4FetchResponseSchema>;

// --- Request schema (M2) ---

export const GA4FetchRequestSchema = z.object({
  period: z
    .object({
      start: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
      end: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
    })
    .refine((p) => new Date(p.end).getTime() >= new Date(p.start).getTime(), {
      message: 'period.end must be >= period.start',
    }),
  sites: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
});
export type GA4FetchRequest = z.infer<typeof GA4FetchRequestSchema>;
