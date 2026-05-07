/**
 * Phase 3 SEO Reports SEMrush — PR 1 SEO `feature/JB/phase-3-seo-helpers-and-cron-foundation`.
 *
 * Helper Deno TS — port progressif primitives legacy `scripts/lib/semrush.js` (Node.js CJS).
 *
 * Cf ADR sealed `D-2026-05-06-sprint-m3-scope-locked` (vault HEAD `29b90fe`)
 *    Brief Cowork `brief-PR-1-SEO-phase-3-helpers-and-cron-foundation.md`
 *
 * Subset porté PR 1 (scope helper Deno minimal upfront) :
 *   - semrushSessionGuard       (pre-flight units estimation)
 *   - semrushSessionRecord      (post-call units tracking)
 *   - rateLimitedSemrushGet     (URL fetch rate-limited 125ms + retry exponential backoff)
 *   - parseSemrushCSV           (response parser)
 *   - validateSemrushData       (response validation domain+rowCount)
 *   - SEMRUSH_SESSION_LIMIT     (constant 2000 units)
 *
 * Out of scope PR 1 (defer PR 2+) :
 *   - rateLimitedSemrushRequest (params variant — URL variant suffit kickoff)
 *   - printUnitsSummary         (n'existe pas legacy module.exports — reconstruction si nécessaire PR 2)
 *   - fetchSemrushData          (full implementation PR 2 Calendar)
 */

/* === Constants === */

export const SEMRUSH_SESSION_LIMIT = 2000;

const SEMRUSH_INTERVAL_MS = 125;

/* === Types === */

export type SemrushFetchOptions = {
  tenantId?: string;
};

export type SemrushSessionState = {
  consumed: number;
  tripped: boolean;
};

export type SemrushFetchResult = {
  rows: Record<string, unknown>[];
  unitsConsumed: number;
  rawResponse: string;
  fetchedAt: string;
};

/* === Session state (module-level singleton, équivalent legacy _semrushSession) === */

const _session: SemrushSessionState = { consumed: 0, tripped: false };

/* === Primitives port === */

/**
 * Pre-flight session guard (port semrushSessionGuard legacy).
 * Throws SEMRUSH_SESSION_LIMIT_EXCEEDED si estimatedUnits dépasse remaining budget session
 * OR si circuit breaker déjà tripped.
 */
export function semrushSessionGuard(estimatedUnits: number): void {
  if (_session.tripped) {
    throw new Error('SEMRUSH_SESSION_LIMIT_EXCEEDED: circuit breaker tripped');
  }
  const remaining = SEMRUSH_SESSION_LIMIT - _session.consumed;
  if (estimatedUnits > remaining) {
    _session.tripped = true;
    throw new Error(
      `SEMRUSH_SESSION_LIMIT_EXCEEDED: estimated ${estimatedUnits} > remaining ${remaining}`,
    );
  }
}

/**
 * Post-call session record (port semrushSessionRecord legacy).
 * Increments consumed counter + trips circuit breaker if hit limit.
 */
export function semrushSessionRecord(units: number): void {
  _session.consumed += units;
  if (_session.consumed >= SEMRUSH_SESSION_LIMIT) {
    _session.tripped = true;
  }
}

/**
 * Get session state snapshot (utility, hors legacy export contract).
 */
export function getSemrushSessionState(): Readonly<SemrushSessionState> {
  return { ..._session };
}

/**
 * Reset session state (utility for tests, hors legacy export contract).
 */
export function resetSemrushSession(): void {
  _session.consumed = 0;
  _session.tripped = false;
}

/* === Rate-limited fetch === */

let _lastRequestAt = 0;

/**
 * Throttle fetch — ensures >= SEMRUSH_INTERVAL_MS between calls.
 */
async function throttleFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - _lastRequestAt;
  if (elapsed < SEMRUSH_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, SEMRUSH_INTERVAL_MS - elapsed));
  }
  _lastRequestAt = Date.now();
  return await fetch(url);
}

/**
 * Rate-limited GET (port rateLimitedSemrushGet legacy).
 * Returns response text (CSV format SEMrush API).
 * Retries 3 attempts with exponential backoff (1s → 2s → 4s).
 * Throws SEMRUSH_API_FAILED tagged error on final failure (errorCode at source PR 0.9 doctrine).
 */
export async function rateLimitedSemrushGet(url: string): Promise<string> {
  const MAX_ATTEMPTS = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await throttleFetch(url);
      if (!response.ok) {
        throw new Error(`SEMRUSH_HTTP_${response.status}: ${response.statusText}`);
      }
      return await response.text();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  const taggedError = new Error(
    `SEMRUSH_API_FAILED: ${MAX_ATTEMPTS} attempts exhausted — ${lastError?.message ?? 'unknown'}`,
  );
  (taggedError as Error & { errorCode?: string }).errorCode = 'SEMRUSH_API_FAILED';
  throw taggedError;
}

/* === CSV parsing === */

/**
 * Parse SEMrush CSV response (port parseSemrushCSV legacy).
 * Returns array of objects keyed by header row.
 * Format SEMrush : separator `;`, header line + N rows.
 */
export function parseSemrushCSV(csvText: string): Record<string, string>[] {
  if (!csvText || csvText.trim() === '') return [];

  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(';').map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(';').map((v) => v.trim());
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? '';
    }
    rows.push(row);
  }

  return rows;
}

/* === Validation === */

/**
 * Validate SEMrush data freshness/sanity (port validateSemrushData legacy).
 * Returns true if rowCount > 0 (data present), false if rowCount = 0 (legitimate empty).
 * Throws SEMRUSH_VALIDATION_FAILED if domain empty OR rowCount NaN/negative.
 */
export function validateSemrushData(domain: string, rowCount: number): boolean {
  if (!domain || domain.trim() === '') {
    throw new Error('SEMRUSH_VALIDATION_FAILED: domain empty');
  }
  if (Number.isNaN(rowCount) || rowCount < 0) {
    throw new Error(`SEMRUSH_VALIDATION_FAILED: invalid rowCount ${rowCount}`);
  }
  return rowCount > 0;
}
