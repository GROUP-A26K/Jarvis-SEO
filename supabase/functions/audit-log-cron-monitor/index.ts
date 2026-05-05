// supabase/functions/audit-log-cron-monitor/index.ts
import { handleMonitor } from './handler.ts';
Deno.serve((req) => handleMonitor(req));
