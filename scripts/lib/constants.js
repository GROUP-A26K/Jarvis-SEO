/**
 * lib/constants.js
 * Constantes partagees : modeles, timeouts, retry, limites.
 *
 * Aucune dependance sur d'autres modules du projet.
 */

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 8000;
const CLAUDE_TIMEOUT_MS = 180000;

// Email recipients from env var (no hardcoded fallback)
const EMAIL_RECIPIENTS = (process.env.EMAIL_RECIPIENTS || '')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);
const MAX_ARTICLES_PER_WEEK = 5;

const DEFAULT_PLAN_UNITS = 50000;
const SEMRUSH_INTERVAL_MS = 125;
const SEMRUSH_SESSION_LIMIT = 2000;

const VALID_PERSONAS = [
  'Hugo Schaller',
  'Amelie Bonvin',
  'Marc Favre',
  'Elodie Rochat',
  'Lucas Morel',
  'Sofia Meier',
  'Philippe Dufour',
  'Nathalie Berger',
];

// ─── Timeouts configurables ─────────────────────────────────
const TIMEOUTS = {
  claude: CLAUDE_TIMEOUT_MS, // 180s — LLM calls
  semrush: 15000, // 15s — API Semrush
  sanity: 30000, // 30s — Sanity CMS
  flux: 60000, // 60s — Flux image generation
  http: 30000, // 30s — generic HTTP
  urlVerify: 5000, // 5s — HEAD request verification
  fileLock: 5000, // 5s — advisory file lock
  gsc: 20000, // 20s — Google Search Console
  email: 15000, // 15s — Resend email
};

// ─── Retry configurables ────────────────────────────────────
const RETRY = {
  claude: { maxRetries: 3, delays: [1000, 3000, 9000] },
  semrush: { maxRetries: 3, delays: [2000, 4000, 8000] },
  flux: { maxRetries: 3, delays: [1000, 2000, 4000] },
  http: { maxRetries: 2, delays: [1000, 3000] },
};

module.exports = {
  CLAUDE_MODEL,
  DEFAULT_MAX_TOKENS,
  CLAUDE_TIMEOUT_MS,
  EMAIL_RECIPIENTS,
  MAX_ARTICLES_PER_WEEK,
  DEFAULT_PLAN_UNITS,
  SEMRUSH_INTERVAL_MS,
  SEMRUSH_SESSION_LIMIT,
  VALID_PERSONAS,
  TIMEOUTS,
  RETRY,
};
