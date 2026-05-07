// supabase/functions/audit-log-cron-monitor/handler.ts
import { createClient } from 'npm:@supabase/supabase-js@2';
import { z } from 'npm:zod';
import { captureWithScope, flushSentry, initSentry } from '../_shared/sentry.ts';

initSentry();

const FailedRunSchema = z.object({
  runid: z.number(),
  jobid: z.number(),
  jobname: z.string(),
  status: z.literal('failed'),
  return_message: z.string().nullable(),
  start_time: z.string(),
  end_time: z.string().nullable(),
});

const ResponseSchema = z.object({
  ok: z.boolean(),
  forwarded: z.number().int().min(0),
  window_minutes: z.number().int().positive(),
  error: z.string().optional(),
});

type FailedRun = z.infer<typeof FailedRunSchema>;
type MonitorResponse = z.infer<typeof ResponseSchema>;

export async function handleMonitor(req: Request): Promise<Response> {
  // 1. Validate Bearer header (INTERNAL_FUNCTION_SECRET)
  const authHeader = req.headers.get('Authorization');
  const internalSecret = Deno.env.get('INTERNAL_FUNCTION_SECRET');
  const expected = internalSecret ? `Bearer ${internalSecret}` : null;
  if (!expected || authHeader !== expected) {
    return jsonResponse(401, {
      ok: false,
      forwarded: 0,
      window_minutes: 0,
      error: 'Unauthorized',
    });
  }

  // 2. Query failed runs in 70 min sliding window via RPC wrapper
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data, error } = await supabase.rpc('get_recent_failed_cron_runs', {
    window_minutes: 70,
  });

  if (error) {
    captureWithScope(new Error(`RPC get_recent_failed_cron_runs failed: ${error.message}`), {
      fingerprint: ['edge-function-error', 'audit-log-cron-monitor', 'rpc-failure'],
      tags: { function: 'audit-log-cron-monitor', error_type: 'rpc' },
      contexts: { rpc_error: { message: error.message, code: error.code } },
    });
    await flushSentry();
    return jsonResponse(500, {
      ok: false,
      forwarded: 0,
      window_minutes: 70,
      error: error.message,
    });
  }

  // 3. Parse + forward each failed run with unique fingerprint dédupe
  const failedRuns: FailedRun[] = (data ?? []).map((r: unknown) => FailedRunSchema.parse(r));

  for (const run of failedRuns) {
    captureWithScope(
      new Error(
        `Cron job ${run.jobname} failed (runid=${run.runid}): ${run.return_message ?? 'no message'}`,
      ),
      {
        fingerprint: ['cron-failure', run.jobname, String(run.runid)],
        tags: { cron: 'true', jobname: run.jobname, monthly: 'true' },
        contexts: {
          cron_run: {
            runid: run.runid,
            jobid: run.jobid,
            start_time: run.start_time,
            end_time: run.end_time ?? 'still-running',
            return_message: run.return_message,
          },
        },
      },
    );
  }

  await flushSentry();

  return jsonResponse(
    200,
    ResponseSchema.parse({
      ok: true,
      forwarded: failedRuns.length,
      window_minutes: 70,
    }),
  );
}

function jsonResponse(status: number, body: MonitorResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
