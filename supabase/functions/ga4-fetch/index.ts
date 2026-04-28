// GA4 fetch Edge Function entry point — thin Deno.serve wrapper.
// All logic lives in handler.ts (testable via DI).
import { handleFetch } from "./handler.ts";

Deno.serve((req) => handleFetch(req));
