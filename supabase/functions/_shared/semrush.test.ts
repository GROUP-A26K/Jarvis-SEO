// supabase/functions/_shared/semrush.test.ts
//
// Tests Deno builtin (cohérent pattern audit-log-cron-monitor/handler.test.ts Sprint M2 warm-up).
// Cf ADR D-2026-05-06-sprint-m3-scope-locked + brief PR 1 SEO Sprint M3 W1.
//
// Run local : deno test --allow-env supabase/functions/_shared/semrush.test.ts
import { assertEquals, assertThrows } from '@std/assert';
import {
  SEMRUSH_SESSION_LIMIT,
  getSemrushSessionState,
  parseSemrushCSV,
  resetSemrushSession,
  semrushSessionGuard,
  semrushSessionRecord,
  validateSemrushData,
} from './semrush.ts';

Deno.test('SEMRUSH_SESSION_LIMIT exported = 2000', () => {
  assertEquals(SEMRUSH_SESSION_LIMIT, 2000);
});

Deno.test('semrushSessionGuard accepts estimation under remaining budget', () => {
  resetSemrushSession();
  semrushSessionGuard(500);
  assertEquals(getSemrushSessionState().tripped, false);
});

Deno.test('semrushSessionGuard throws when estimation exceeds remaining budget', () => {
  resetSemrushSession();
  assertThrows(() => semrushSessionGuard(2001), Error, 'SEMRUSH_SESSION_LIMIT_EXCEEDED');
});

Deno.test('semrushSessionGuard trips circuit when estimation exceeds remaining', () => {
  resetSemrushSession();
  try {
    semrushSessionGuard(2001);
  } catch (_err) {
    // expected
  }
  assertEquals(getSemrushSessionState().tripped, true);
});

Deno.test('semrushSessionRecord increments consumed counter', () => {
  resetSemrushSession();
  semrushSessionRecord(100);
  assertEquals(getSemrushSessionState().consumed, 100);
  semrushSessionRecord(50);
  assertEquals(getSemrushSessionState().consumed, 150);
});

Deno.test('semrushSessionRecord trips circuit at SEMRUSH_SESSION_LIMIT', () => {
  resetSemrushSession();
  semrushSessionRecord(SEMRUSH_SESSION_LIMIT);
  assertEquals(getSemrushSessionState().tripped, true);
});

Deno.test('semrushSessionGuard throws when circuit already tripped', () => {
  resetSemrushSession();
  semrushSessionRecord(SEMRUSH_SESSION_LIMIT);
  assertThrows(() => semrushSessionGuard(1), Error, 'circuit breaker tripped');
});

Deno.test('resetSemrushSession resets consumed and tripped', () => {
  semrushSessionRecord(SEMRUSH_SESSION_LIMIT);
  resetSemrushSession();
  const state = getSemrushSessionState();
  assertEquals(state.consumed, 0);
  assertEquals(state.tripped, false);
});

Deno.test('parseSemrushCSV returns empty array on empty input', () => {
  assertEquals(parseSemrushCSV(''), []);
  assertEquals(parseSemrushCSV('   '), []);
});

Deno.test('parseSemrushCSV returns empty when only header row', () => {
  assertEquals(parseSemrushCSV('Keyword;Position;Volume'), []);
});

Deno.test('parseSemrushCSV parses semicolon-separated rows', () => {
  const csv = 'Keyword;Position;Volume\nfiduciaire geneve;1;500\ncomptable suisse;3;200';
  const rows = parseSemrushCSV(csv);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].Keyword, 'fiduciaire geneve');
  assertEquals(rows[0].Position, '1');
  assertEquals(rows[0].Volume, '500');
  assertEquals(rows[1].Keyword, 'comptable suisse');
  assertEquals(rows[1].Position, '3');
});

Deno.test('parseSemrushCSV handles missing values as empty strings', () => {
  const csv = 'Keyword;Position;Volume\nfiduciaire geneve;1';
  const rows = parseSemrushCSV(csv);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].Keyword, 'fiduciaire geneve');
  assertEquals(rows[0].Position, '1');
  assertEquals(rows[0].Volume, '');
});

Deno.test('validateSemrushData throws on empty domain', () => {
  assertThrows(() => validateSemrushData('', 10), Error, 'domain empty');
});

Deno.test('validateSemrushData throws on whitespace-only domain', () => {
  assertThrows(() => validateSemrushData('   ', 10), Error, 'domain empty');
});

Deno.test('validateSemrushData throws on NaN rowCount', () => {
  assertThrows(
    () => validateSemrushData('fiduciaire-genevoise.ch', NaN),
    Error,
    'invalid rowCount',
  );
});

Deno.test('validateSemrushData throws on negative rowCount', () => {
  assertThrows(() => validateSemrushData('fiduciaire-genevoise.ch', -1), Error, 'invalid rowCount');
});

Deno.test('validateSemrushData returns true for valid domain + rowCount > 0', () => {
  assertEquals(validateSemrushData('fiduciaire-genevoise.ch', 10), true);
});

Deno.test('validateSemrushData returns false for valid domain + rowCount = 0', () => {
  assertEquals(validateSemrushData('fiduciaire-genevoise.ch', 0), false);
});

// Note : tests rateLimitedSemrushGet (HTTP fetch + retry backoff timing) = follow-up via mock fetch global,
// scope minimal cette PR (cohérent D1 minimal upfront helper port + tests basiques).
