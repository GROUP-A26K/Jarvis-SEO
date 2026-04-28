// Mock GA4 client — canned data per slug for skeleton-only.
// SWAP E6: real implementation will use @google-analytics/data SDK.
// Threshold logic per D-2026-04-27-ga4-granularity:
//   page included if (sessions/overall > 1%) OR (sessions > 100).

import type { OverallMetrics, PageMetrics } from "./schema.ts";

export interface GA4Client {
  fetchOverall(propertyId: string): Promise<OverallMetrics>;
  fetchPerPage(
    propertyId: string,
    overallSessions: number,
  ): Promise<PageMetrics[]>;
}

// Static propertyId → slug inversed map mirroring sites/ga4-properties.json.
// Kept inline (rather than via loadSiteMapping) for skeleton simplicity:
// no IO dependency, deterministic, easily replaced wholesale at E6 swap.
const PROPERTY_TO_SLUG: Record<string, string> = {
  "456013258": "fg",
  "515212797": "fv",
  "518553284": "mc",
  "483368599": "rg",
  "510195526": "ig",
};

const CANNED_DATA: Record<string, OverallMetrics> = {
  fg: { sessions: 4250, users: 3180, engagement_rate: 0.62, key_events: 47 },
  fv: { sessions: 1840, users: 1420, engagement_rate: 0.58, key_events: 19 },
  mc: { sessions: 720, users: 560, engagement_rate: 0.71, key_events: 11 },
  rg: { sessions: 320, users: 240, engagement_rate: 0.49, key_events: 4 },
  ig: { sessions: 1560, users: 1180, engagement_rate: 0.55, key_events: 22 },
};

type PageFixture = {
  path: string;
  pct: number;
  engagementOffset: number;
};

// Page distribution per site (sums to ~80%, rest = long tail not enumerated).
// Each entry declares pct of overall site traffic + engagement offset to
// produce plausible per-page engagement rate.
const PAGE_FIXTURES: PageFixture[] = [
  { path: "/", pct: 0.35, engagementOffset: 0.0 },
  { path: "/services", pct: 0.17, engagementOffset: -0.02 },
  { path: "/contact", pct: 0.12, engagementOffset: 0.05 },
  { path: "/about", pct: 0.07, engagementOffset: -0.03 },
  { path: "/blog", pct: 0.05, engagementOffset: 0.02 },
  { path: "/blog/post-1", pct: 0.025, engagementOffset: 0.04 },
  { path: "/blog/post-2", pct: 0.015, engagementOffset: 0.01 },
  { path: "/legal", pct: 0.005, engagementOffset: -0.05 },
  { path: "/404", pct: 0.001, engagementOffset: -0.1 },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lookupSlug(propertyId: string): string {
  const slug = PROPERTY_TO_SLUG[propertyId];
  if (!slug) {
    throw new Error(`Mock GA4 client: unknown propertyId "${propertyId}"`);
  }
  return slug;
}

function derivePage(
  fixture: PageFixture,
  overall: OverallMetrics,
): PageMetrics | null {
  const sessions = Math.round(overall.sessions * fixture.pct);
  const pctMatch = overall.sessions > 0 &&
    sessions / overall.sessions > 0.01;
  const absMatch = sessions > 100;
  if (!pctMatch && !absMatch) return null;

  const userRatio = overall.sessions > 0
    ? overall.users / overall.sessions
    : 0;
  const eventRatio = overall.sessions > 0
    ? overall.key_events / overall.sessions
    : 0;
  const users = Math.round(sessions * userRatio);
  const engagement_rate = clamp(
    overall.engagement_rate + fixture.engagementOffset,
    0,
    1,
  );
  const key_events = Math.round(sessions * eventRatio);

  let threshold_match: PageMetrics["threshold_match"];
  if (pctMatch && absMatch) threshold_match = "both";
  else if (pctMatch) threshold_match = "pct_traffic";
  else threshold_match = "absolute_volume";

  return {
    page_path: fixture.path,
    sessions,
    users,
    engagement_rate,
    key_events,
    threshold_match,
  };
}

export const defaultGa4Client: GA4Client = {
  fetchOverall(propertyId: string): Promise<OverallMetrics> {
    const slug = lookupSlug(propertyId);
    const data = CANNED_DATA[slug];
    if (!data) {
      throw new Error(`Mock GA4 client: no canned data for slug "${slug}"`);
    }
    return Promise.resolve({ ...data });
  },
  fetchPerPage(
    propertyId: string,
    overallSessions: number,
  ): Promise<PageMetrics[]> {
    const slug = lookupSlug(propertyId);
    const data = CANNED_DATA[slug];
    if (!data) {
      throw new Error(`Mock GA4 client: no canned data for slug "${slug}"`);
    }
    const overall: OverallMetrics = { ...data, sessions: overallSessions };
    const pages = PAGE_FIXTURES
      .map((f) => derivePage(f, overall))
      .filter((p): p is PageMetrics => p !== null);
    return Promise.resolve(pages);
  },
};
