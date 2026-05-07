// supabase/functions/semrush-fetch-cron/handler.test.ts
//
// Tests Deno builtin (cohérent pattern audit-log-cron-monitor/handler.test.ts Sprint M2 warm-up).
// Cf ADR D-2026-05-06-sprint-m3-scope-locked + brief PR 1 SEO Sprint M3 W1.
//
// Run local : deno test --allow-env --config=supabase/functions/deno.json supabase/functions/semrush-fetch-cron/handler.test.ts
import { assertEquals } from '@std/assert';
import { handleSemrushFetchCron } from './handler.ts';

Deno.test('rejects request without Authorization header', async () => {
  Deno.env.set('INTERNAL_FUNCTION_SECRET', 'expected-secret');
  const req = new Request('http://localhost/semrush-fetch-cron', { method: 'POST' });
  const res = await handleSemrushFetchCron(req);
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.ok, false);
  assertEquals(body.error, 'Unauthorized');
});

Deno.test('rejects request with wrong Bearer token', async () => {
  Deno.env.set('INTERNAL_FUNCTION_SECRET', 'expected-secret');
  const req = new Request('http://localhost/semrush-fetch-cron', {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-secret' },
  });
  const res = await handleSemrushFetchCron(req);
  assertEquals(res.status, 401);
});

Deno.test('rejects request without INTERNAL_FUNCTION_SECRET env set', async () => {
  Deno.env.delete('INTERNAL_FUNCTION_SECRET');
  const req = new Request('http://localhost/semrush-fetch-cron', {
    method: 'POST',
    headers: { Authorization: 'Bearer any-token' },
  });
  const res = await handleSemrushFetchCron(req);
  assertEquals(res.status, 401);
});

Deno.test('rejects request with malformed Authorization header (no Bearer prefix)', async () => {
  Deno.env.set('INTERNAL_FUNCTION_SECRET', 'expected-secret');
  const req = new Request('http://localhost/semrush-fetch-cron', {
    method: 'POST',
    headers: { Authorization: 'expected-secret' },
  });
  const res = await handleSemrushFetchCron(req);
  assertEquals(res.status, 401);
});

Deno.test('accepts valid Bearer + returns 200 ok skeleton placeholder', async () => {
  Deno.env.set('INTERNAL_FUNCTION_SECRET', 'expected-secret');
  const req = new Request('http://localhost/semrush-fetch-cron', {
    method: 'POST',
    headers: { Authorization: 'Bearer expected-secret' },
  });
  const res = await handleSemrushFetchCron(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  // env_marker null car checkEnvMarker placeholder retourne null PR 1 skeleton
  assertEquals(body.env_marker, null);
  assertEquals(body.forwarded, 0);
  assertEquals(body.window_minutes, 0);
});

// Note : tests d'intégration avec marker table mock + Supabase RPC mock = follow-up PR 2,
// scope minimal cette PR (cohérent D1 minimal upfront skeleton placeholder).
