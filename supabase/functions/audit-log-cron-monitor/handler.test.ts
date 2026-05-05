// supabase/functions/audit-log-cron-monitor/handler.test.ts
import { assertEquals } from '@std/assert';
import { handleMonitor } from './handler.ts';

Deno.test('rejects request without Authorization header', async () => {
  Deno.env.set('INTERNAL_FUNCTION_SECRET', 'expected-secret');
  const req = new Request('http://localhost/audit-log-cron-monitor', {
    method: 'POST',
  });
  const res = await handleMonitor(req);
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.ok, false);
  assertEquals(body.error, 'Unauthorized');
});

Deno.test('rejects request with wrong Bearer token', async () => {
  Deno.env.set('INTERNAL_FUNCTION_SECRET', 'expected-secret');
  const req = new Request('http://localhost/audit-log-cron-monitor', {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-secret' },
  });
  const res = await handleMonitor(req);
  assertEquals(res.status, 401);
});

Deno.test('rejects request without INTERNAL_FUNCTION_SECRET env set', async () => {
  Deno.env.delete('INTERNAL_FUNCTION_SECRET');
  const req = new Request('http://localhost/audit-log-cron-monitor', {
    method: 'POST',
    headers: { Authorization: 'Bearer any-token' },
  });
  const res = await handleMonitor(req);
  assertEquals(res.status, 401);
});

// Note : tests d'intégration avec Sentry mock + Supabase RPC mock = follow-up,
// scope minimal cette PR (cohérent D1 minimal upfront cf ADR sealed).
