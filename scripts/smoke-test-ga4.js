#!/usr/bin/env node
/**
 * smoke-test-ga4.js — Phase 2 GA4 Section G reference smoke test
 *
 * Verifies the jarvis-ga4-a26k service account can call runReport on
 * each GA4 property where it was granted Viewer access (5 properties :
 * FG/FV/MC/RG/IG ; AG+AM différés).
 *
 * Usage : node scripts/smoke-test-ga4.js
 * Secret : ~/.jarvis-secrets/gcp-jarvis-ga4-a26k.json (gitignored, local only)
 *
 * Reference example for the Edge Function ga4-fetch real GA4 client
 * (see supabase/functions/_shared/ga4-client.ts — same SDK, Deno port).
 * Preserved post E6 swap as repro tool for service account /
 * property access debugging.
 */

const path = require('path');
const os = require('os');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

const KEY_FILE = path.join(os.homedir(), '.jarvis-secrets', 'gcp-jarvis-ga4-a26k.json');

const PROPERTIES = [
  { id: '518553284', label: 'MedCourtage' },
  { id: '456013258', label: 'FG (Fiduciaire Genevoise)' },
  { id: '515212797', label: 'FV (Fiduciaire Vaudoise)' },
  { id: '483368599', label: 'RG (Relocation Genevoise)' },
  { id: '510195526', label: 'IG (Immobilière Genevoise)' },
];

async function runReportForProperty(client, { id, label }) {
  const [response] = await client.runReport({
    property: `properties/${id}`,
    dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
    metrics: [{ name: 'sessions' }],
    dimensions: [{ name: 'date' }],
  });

  const rows = response.rows || [];
  const totalSessions = rows.reduce((sum, r) => sum + Number(r.metricValues?.[0]?.value || 0), 0);

  return { rows, totalSessions, rowCount: response.rowCount || rows.length };
}

async function main() {
  console.log(`Service account key: ${KEY_FILE}`);
  const client = new BetaAnalyticsDataClient({ keyFilename: KEY_FILE });

  const results = [];
  for (const prop of PROPERTIES) {
    process.stdout.write(`\n=== ${prop.label} (${prop.id}) ===\n`);
    try {
      const { rows, totalSessions, rowCount } = await runReportForProperty(client, prop);
      console.log(`OK — ${rowCount} day(s), total sessions = ${totalSessions}`);
      rows.slice(0, 3).forEach((r) => {
        console.log(`  ${r.dimensionValues[0].value}: ${r.metricValues[0].value} sessions`);
      });
      if (rows.length > 3) console.log(`  ...(${rows.length - 3} more days)`);
      results.push({ ...prop, status: 'OK', totalSessions, rowCount });
    } catch (err) {
      const msg = err.details || err.message || String(err);
      console.log(`FAIL — ${msg}`);
      results.push({ ...prop, status: 'FAIL', error: msg });
    }
  }

  console.log('\n=== Summary ===');
  console.log('| Site | Property ID | Status | Sessions (7d) |');
  console.log('|------|-------------|--------|---------------|');
  for (const r of results) {
    const sessions = r.status === 'OK' ? r.totalSessions : `ERR: ${r.error}`;
    console.log(`| ${r.label} | ${r.id} | ${r.status} | ${sessions} |`);
  }

  const failed = results.filter((r) => r.status !== 'OK').length;
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
