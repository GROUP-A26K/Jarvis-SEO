// supabase/functions/semrush-fetch-cron/index.ts
import { handleSemrushFetchCron } from './handler.ts';
Deno.serve((req) => handleSemrushFetchCron(req));
