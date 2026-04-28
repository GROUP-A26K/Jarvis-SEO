import { z } from 'zod';
import { assertEquals, assertThrows } from '@std/assert';
import {
  GA4FetchRequestSchema,
  GA4FetchResponseSchema,
  OverallMetricsSchema,
  SiteMetricsSchema,
} from './schema.ts';

// --- Round-trip ---

Deno.test('GA4FetchResponse round-trip parses valid full payload', () => {
  const fixture = {
    status: 'partial',
    data: {
      sites: [
        {
          slug: 'fg',
          property_id: '456013258',
          overall: {
            sessions: 4250,
            users: 3180,
            engagement_rate: 0.62,
            key_events: 47,
          },
          per_page: [
            {
              page_path: '/blog/article-1',
              sessions: 200,
              users: 150,
              engagement_rate: 0.55,
              key_events: 3,
              threshold_match: 'both',
            },
          ],
        },
        {
          slug: 'rg',
          property_id: '483368599',
          overall: null,
          per_page: [],
        },
      ],
      aggregates: {
        total_sessions_all_sites: 4250,
        total_users_all_sites: 3180,
        sites_with_data: 1,
        sites_with_errors: 1,
      },
    },
    errors: [
      {
        site_slug: 'rg',
        scope: 'quota',
        message: 'GA4 API quota exceeded',
        property_id: '483368599',
        caught_at: '2026-04-28T11:00:00+02:00',
      },
    ],
    meta: {
      fetched_at: '2026-04-28T11:00:00+02:00',
      client_id: '17c6c2c9-aaaa-bbbb-cccc-000000000000',
      period: {
        start: '2026-04-01T00:00:00Z',
        end: '2026-04-30T23:59:59Z',
      },
    },
  };
  const parsed = GA4FetchResponseSchema.parse(fixture);
  assertEquals(parsed.status, 'partial');
  assertEquals(parsed.data.sites.length, 2);
  assertEquals(parsed.data.sites[0].overall?.sessions, 4250);
  assertEquals(parsed.data.sites[1].overall, null);
  assertEquals(parsed.errors.length, 1);
});

// --- engagement_rate bornes (OverallMetricsSchema) ---

const baseMetrics = { sessions: 100, users: 80, key_events: 5 };

Deno.test('engagement_rate accepts 0.0', () => {
  OverallMetricsSchema.parse({ ...baseMetrics, engagement_rate: 0.0 });
});

Deno.test('engagement_rate accepts 1.0', () => {
  OverallMetricsSchema.parse({ ...baseMetrics, engagement_rate: 1.0 });
});

Deno.test('engagement_rate rejects 1.5', () => {
  assertThrows(
    () => OverallMetricsSchema.parse({ ...baseMetrics, engagement_rate: 1.5 }),
    z.ZodError,
  );
});

Deno.test('engagement_rate rejects -0.1', () => {
  assertThrows(
    () => OverallMetricsSchema.parse({ ...baseMetrics, engagement_rate: -0.1 }),
    z.ZodError,
  );
});

// --- property_id bornes (SiteMetricsSchema, regex M1 /^\d{8,12}$/) ---

const baseSite = { slug: 'fg', overall: null, per_page: [] };

Deno.test('property_id accepts 9 digits', () => {
  SiteMetricsSchema.parse({ ...baseSite, property_id: '123456789' });
});

Deno.test('property_id accepts 11 digits', () => {
  SiteMetricsSchema.parse({ ...baseSite, property_id: '12345678901' });
});

Deno.test('property_id rejects 7 digits', () => {
  assertThrows(() => SiteMetricsSchema.parse({ ...baseSite, property_id: '1234567' }), z.ZodError);
});

Deno.test('property_id rejects non-digit chars', () => {
  assertThrows(
    () => SiteMetricsSchema.parse({ ...baseSite, property_id: 'abc123456' }),
    z.ZodError,
  );
});

// --- slug bornes (SiteMetricsSchema, regex M9 /^[a-z0-9-]+$/, min 2 / max 20) ---

const baseSiteForSlug = {
  property_id: '456013258',
  overall: null,
  per_page: [],
};

Deno.test("slug accepts 'fg'", () => {
  SiteMetricsSchema.parse({ ...baseSiteForSlug, slug: 'fg' });
});

Deno.test("slug accepts 'fiduciaire-genevoise' (20 chars max)", () => {
  // Length check: f-i-d-u-c-i-a-i-r-e (10) + - (1) + g-e-n-e-v-o-i-s-e (9) = 20.
  assertEquals('fiduciaire-genevoise'.length, 20);
  SiteMetricsSchema.parse({ ...baseSiteForSlug, slug: 'fiduciaire-genevoise' });
});

Deno.test("slug rejects uppercase 'FG'", () => {
  assertThrows(() => SiteMetricsSchema.parse({ ...baseSiteForSlug, slug: 'FG' }), z.ZodError);
});

Deno.test("slug rejects underscore 'fg_test'", () => {
  assertThrows(() => SiteMetricsSchema.parse({ ...baseSiteForSlug, slug: 'fg_test' }), z.ZodError);
});

Deno.test("slug rejects single char 'f' (min 2)", () => {
  assertThrows(() => SiteMetricsSchema.parse({ ...baseSiteForSlug, slug: 'f' }), z.ZodError);
});

// --- period refine (GA4FetchRequestSchema, M2) ---

Deno.test('period accepts end > start', () => {
  GA4FetchRequestSchema.parse({
    period: { start: '2026-04-01T00:00:00Z', end: '2026-04-30T23:59:59Z' },
  });
});

Deno.test('period rejects start > end', () => {
  assertThrows(
    () =>
      GA4FetchRequestSchema.parse({
        period: { start: '2026-04-30T23:59:59Z', end: '2026-04-01T00:00:00Z' },
      }),
    z.ZodError,
  );
});
