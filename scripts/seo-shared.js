/**
 * seo-shared.js v4 — Backward-compatible re-exporter
 *
 * Ce fichier ne contient plus de logique propre. Il re-expose les 67 symboles
 * historiquement exportes, en les important depuis les modules specialises
 * sous scripts/lib/.
 *
 * Pour le nouveau code, preferer les imports directs :
 *   const { logger } = require('./lib/logger');
 *   const { callClaudeWithRetry } = require('./lib/claude');
 *
 * La liste ci-dessous preserve l'ordre historique des exports pour faciliter
 * le diff lors de revisions ulterieures.
 *
 * IMPORTANT : chaque require top-level declenche les side-effects du module
 * importe. En particulier, require('./lib/locks') enregistre les 5 handlers
 * process.on (exit, SIGINT, SIGTERM, unhandledRejection, uncaughtException).
 * Ne pas convertir en lazy imports.
 *
 * Jarvis One — Groupe Genevoise
 */

const { PATHS } = require('./lib/paths');
const {
  CLAUDE_MODEL,
  DEFAULT_MAX_TOKENS,
  CLAUDE_TIMEOUT_MS,
  EMAIL_RECIPIENTS,
  MAX_ARTICLES_PER_WEEK,
  VALID_PERSONAS,
  TIMEOUTS,
  RETRY,
  SEMRUSH_SESSION_LIMIT,
} = require('./lib/constants');
const { circuitBreakers, createCircuitBreaker } = require('./lib/circuit');
const { logger } = require('./lib/logger');
const { validateEnv, getApiKey, requireAnthropicKey } = require('./lib/env');
const {
  ensureDir,
  writeFileAtomic,
  readJSONSafe,
  writeJSONAtomic,
} = require('./lib/fs-utils');
const { acquireLock, withLockedJSON } = require('./lib/locks');
const { loadSecret } = require('./lib/secrets');
const {
  loadSitesConfig,
  getSiteConfig,
  getSiteList,
  getSiteLabels,
  invalidateSitesConfigCache,
  getConfigMeta,
  getSanityDefaults,
  getSanityDocType,
  getPersonaDetails,
  getSitePersonas,
  getSiteFallbackCompetitors,
  getSiteSources,
  getSiteEntity,
  getSiteFinma,
  getSiteStableSources,
  getSiteExhibitStyle,
} = require('./lib/config');
const { httpRequest } = require('./lib/http');
const {
  esc,
  sanitize,
  sanitizeFilename,
  sanitizeSlug,
  sanitizeArticleForLLM,
  sanitizeErrorMessage,
} = require('./lib/sanitize');
const {
  rateLimitedSemrushGet,
  rateLimitedSemrushRequest,
  parseSemrushCSV,
  semrushSessionGuard,
  semrushSessionRecord,
  validateSemrushData,
} = require('./lib/semrush');
const { tavilySearch } = require('./lib/tavily');
const {
  trackUnits,
  printUnitsSummary,
  loadUnitsState,
  loadTrackedArticles,
  updateArticleField,
  loadLatestGapAnalysis,
  loadPipelineState,
  savePipelineState,
} = require('./lib/tracking');
const { callClaudeWithRetry, extractClaudeText } = require('./lib/claude');
const { verifyUrl } = require('./lib/verify');
const { sendEmail } = require('./lib/email');
const { validateArticleInput } = require('./lib/validation');
const { getISOWeek } = require('./lib/helpers');

// ═══════════════════════════════════════════════════════════════
// EXPORTS (ordre historique preserve pour faciliter le diff git)
// ═══════════════════════════════════════════════════════════════
module.exports = {
  PATHS, CLAUDE_MODEL, DEFAULT_MAX_TOKENS, CLAUDE_TIMEOUT_MS,
  EMAIL_RECIPIENTS, MAX_ARTICLES_PER_WEEK, VALID_PERSONAS,
  TIMEOUTS, RETRY, circuitBreakers, createCircuitBreaker,
  logger, validateEnv, getApiKey, requireAnthropicKey,
  ensureDir, writeFileAtomic, readJSONSafe, writeJSONAtomic, acquireLock, withLockedJSON,
  loadSecret, loadSitesConfig, getSiteConfig, getSiteList, getSiteLabels, invalidateSitesConfigCache,
  getConfigMeta, getSanityDefaults, getSanityDocType, getPersonaDetails, getSitePersonas,
  getSiteFallbackCompetitors, getSiteSources, getSiteEntity, getSiteFinma, getSiteStableSources, getSiteExhibitStyle,
  httpRequest, esc,
  sanitize, sanitizeFilename, sanitizeSlug, sanitizeArticleForLLM, sanitizeErrorMessage,
  rateLimitedSemrushGet, rateLimitedSemrushRequest, parseSemrushCSV, tavilySearch,
  semrushSessionGuard, semrushSessionRecord, SEMRUSH_SESSION_LIMIT,
  validateSemrushData, trackUnits, printUnitsSummary, loadUnitsState,
  callClaudeWithRetry, extractClaudeText,
  verifyUrl,
  loadTrackedArticles, updateArticleField,
  loadLatestGapAnalysis, loadPipelineState, savePipelineState,
  sendEmail, validateArticleInput, getISOWeek,
};
