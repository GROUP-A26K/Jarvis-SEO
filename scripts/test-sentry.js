#!/usr/bin/env node
/**
 * test-sentry.js
 * Smoke test script for @sentry/node integration.
 *
 * Throws an error to verify Sentry captures it correctly with release,
 * environment, and script tag. Safe to run in production (does not touch
 * Supabase, Sanity, or any other resource).
 *
 * Usage:
 *   SENTRY_DSN_SEO=... SENTRY_ENVIRONMENT=production node scripts/test-sentry.js
 */
const sentry = require('./lib/sentry');
sentry.init({ script: 'test-sentry' });

async function main() {
  console.log('========================================');
  console.log('  Sentry smoke test');
  console.log('  isEnabled:', sentry.isEnabled());
  console.log('  timestamp:', new Date().toISOString());
  console.log('========================================');

  // Add a breadcrumb to enrich the event context
  sentry.addBreadcrumb({
    category: 'test',
    message: 'About to throw a test error',
    level: 'info',
  });

  // This will propagate up to main().catch() and be captured by sentry.fatal()
  throw new Error(
    'Sentry smoke test PR 0.1b — ' +
      new Date().toISOString() +
      ' — if you see this in Sentry UI, the integration works.',
  );
}

main().catch((err) => sentry.fatal(err));
