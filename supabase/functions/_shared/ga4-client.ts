// Mock GA4 client — daily fixtures. Skeleton-only.
// SWAP E6 (commit 4) : defaultGa4Client body remplacé par real GA4 Data API.
// Threshold logic vit côté handler (calcul sur agrégat per-page, pas par jour).
// Interface stable inter-commits : tests injectent leurs propres mocks via DI.

import type { DailyOverall, DailyPerPage, Period } from './schema.ts';

export interface GA4Client {
  fetchOverall(propertyId: string, period: Period): Promise<DailyOverall[]>;
  fetchPerPage(
    propertyId: string,
    period: Period,
    overallByDate: Record<string, number>,
  ): Promise<DailyPerPage[]>;
}

// Static propertyId → slug inversed map mirroring sites/ga4-properties.json.
// Kept inline (rather than via loadSiteMapping) for skeleton simplicity:
// no IO dependency, deterministic, easily replaced wholesale at E6 swap.
const PROPERTY_TO_SLUG: Record<string, string> = {
  '456013258': 'fg',
  '515212797': 'fv',
  '518553284': 'mc',
  '483368599': 'rg',
  '510195526': 'ig',
};

type SiteFixture = {
  sessions: number;
  users: number;
  engagement_rate: number;
  key_events: number;
};

const CANNED_DATA: Record<string, SiteFixture> = {
  fg: { sessions: 4250, users: 3180, engagement_rate: 0.62, key_events: 47 },
  fv: { sessions: 1840, users: 1420, engagement_rate: 0.58, key_events: 19 },
  mc: { sessions: 720, users: 560, engagement_rate: 0.71, key_events: 11 },
  rg: { sessions: 320, users: 240, engagement_rate: 0.49, key_events: 4 },
  ig: { sessions: 1560, users: 1180, engagement_rate: 0.55, key_events: 22 },
};

// Page distribution per site (sums to ~80%, rest = long tail not enumerated).
const PAGE_FIXTURES: Array<{ path: string; pct: number }> = [
  { path: '/', pct: 0.35 },
  { path: '/services', pct: 0.17 },
  { path: '/contact', pct: 0.12 },
  { path: '/about', pct: 0.07 },
  { path: '/blog', pct: 0.05 },
  { path: '/blog/post-1', pct: 0.025 },
  { path: '/blog/post-2', pct: 0.015 },
  { path: '/legal', pct: 0.005 },
];

function lookupSlug(propertyId: string): string {
  const slug = PROPERTY_TO_SLUG[propertyId];
  if (!slug) {
    throw new Error(`Mock GA4 client: unknown propertyId "${propertyId}"`);
  }
  return slug;
}

// Enumerate inclusive daily date strings YYYY-MM-DD spanning the period.
// Period start/end are ISO datetime offset (request-validated) — slice(0,10) is safe.
function enumerateDates(period: Period): string[] {
  const startDate = period.start.slice(0, 10);
  const endDate = period.end.slice(0, 10);
  const dates: string[] = [];
  const cur = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cur.getTime() <= end.getTime()) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

export const defaultGa4Client: GA4Client = {
  fetchOverall(propertyId: string, period: Period): Promise<DailyOverall[]> {
    const slug = lookupSlug(propertyId);
    const data = CANNED_DATA[slug];
    if (!data) {
      throw new Error(`Mock GA4 client: no canned data for slug "${slug}"`);
    }
    const dates = enumerateDates(period);
    if (dates.length === 0) return Promise.resolve([]);
    const sessions = Math.floor(data.sessions / dates.length);
    const users = Math.floor(data.users / dates.length);
    const key_events = Math.floor(data.key_events / dates.length);
    return Promise.resolve(
      dates.map((date) => ({
        date,
        sessions,
        users,
        engagement_rate: data.engagement_rate,
        key_events,
      })),
    );
  },
  fetchPerPage(
    propertyId: string,
    period: Period,
    _overallByDate: Record<string, number>,
  ): Promise<DailyPerPage[]> {
    const slug = lookupSlug(propertyId);
    const data = CANNED_DATA[slug];
    if (!data) {
      throw new Error(`Mock GA4 client: no canned data for slug "${slug}"`);
    }
    const dates = enumerateDates(period);
    if (dates.length === 0) return Promise.resolve([]);
    const userRatio = data.sessions > 0 ? data.users / data.sessions : 0;
    const eventRatio = data.sessions > 0 ? data.key_events / data.sessions : 0;
    const sitePerDay = Math.floor(data.sessions / dates.length);
    const out: DailyPerPage[] = [];
    for (const date of dates) {
      for (const fixture of PAGE_FIXTURES) {
        const sessions = Math.round(sitePerDay * fixture.pct);
        if (sessions === 0) continue;
        out.push({
          date,
          page_path: fixture.path,
          sessions,
          users: Math.round(sessions * userRatio),
          engagement_rate: data.engagement_rate,
          key_events: Math.round(sessions * eventRatio),
        });
      }
    }
    return Promise.resolve(out);
  },
};
