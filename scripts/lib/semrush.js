/**
 * lib/semrush.js
 * Client SEMrush API avec rate limiting, circuit breaker, session guard,
 * parsing CSV, et validation de donnees.
 *
 * Session guard : limite hard de 2000 unites par exécution (process),
 * independamment du compteur mensuel persistant. Protection anti-boucle.
 *
 * Le rate limiter (SEMRUSH_INTERVAL_MS = 125ms entre requetes) et le
 * circuit breaker (apres N echecs) protegent contre l'epuisement du quota
 * et le spam d'un service en panne.
 *
 * Depend de paths.js, constants.js (SEMRUSH_SESSION_LIMIT, SEMRUSH_INTERVAL_MS,
 * RETRY, TIMEOUTS), logger.js, circuit.js, sanitize.js, fs-utils.js.
 */

const https = require('https');
const { PATHS } = require('./paths');
const {
  SEMRUSH_SESSION_LIMIT,
  SEMRUSH_INTERVAL_MS,
  RETRY,
  TIMEOUTS,
} = require('./constants');
const { logger } = require('./logger');
const { circuitBreakers } = require('./circuit');
const { sanitizeErrorMessage } = require('./sanitize');
const { readJSONSafe, writeJSONAtomic } = require('./fs-utils');

// ─── Rate limiter state ─────────────────────────────────────────
let lastRequestTime = 0;
let requestQueue = Promise.resolve();

// ─── Session guard state ────────────────────────────────────────
// Agent de securite anti-boucle : limite 2000 unites par process,
// independamment du compteur mensuel persistant.
const _semrushSession = { consumed: 0, tripped: false };

function semrushSessionGuard(estimatedUnits) {
  if (_semrushSession.tripped) {
    throw new Error(`[SEMRUSH GUARD] Disjoncteur de session actif — limite ${SEMRUSH_SESSION_LIMIT} unités atteinte (${_semrushSession.consumed} consommées). Arrêt de sécurité.`);
  }
  const est = estimatedUnits || 10;
  if (_semrushSession.consumed + est > SEMRUSH_SESSION_LIMIT) {
    _semrushSession.tripped = true;
    throw new Error(`[SEMRUSH GUARD] Limite de session ${SEMRUSH_SESSION_LIMIT} unités dépassée (${_semrushSession.consumed} + ${est} estimées). Arrêt de sécurité.`);
  }
}

function semrushSessionRecord(units) {
  _semrushSession.consumed += (units || 10);
  const pct = Math.round(_semrushSession.consumed / SEMRUSH_SESSION_LIMIT * 100);
  if (pct >= 80 && !_semrushSession._warned80) {
    _semrushSession._warned80 = true;
    logger.warn(`[SEMRUSH GUARD] Session: ${_semrushSession.consumed}/${SEMRUSH_SESSION_LIMIT} unités (${pct}%) — ${SEMRUSH_SESSION_LIMIT - _semrushSession.consumed} restantes`);
  }
  if (_semrushSession.consumed >= SEMRUSH_SESSION_LIMIT) {
    _semrushSession.tripped = true;
    logger.warn(`[SEMRUSH GUARD] Limite de session atteinte — plus aucun appel Semrush autorisé pour ce process`);
  }
}

// ─── Rate limiter + circuit breaker ─────────────────────────────

function rateLimitedSemrushGet(url) {
  // Security guard — limite session 2000 unites
  try { semrushSessionGuard(10); } catch (e) { return Promise.reject(e); }

  // Circuit breaker check
  if (!circuitBreakers.semrush.canExecute()) {
    return Promise.reject(new Error('Semrush circuit breaker OUVERT — service temporairement indisponible'));
  }
  const task = requestQueue.then(() => _throttledGet(url));
  requestQueue = task.catch(() => {});
  return task;
}

function _throttledGet(url) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const delay = Math.max(0, SEMRUSH_INTERVAL_MS - (now - lastRequestTime));
    setTimeout(() => {
      lastRequestTime = Date.now();
      _semrushGetWithBackoff(url, 0, resolve, reject);
    }, delay);
  });
}

/** Redact the key= query parameter from Semrush URLs before logging */
function sanitizeSemrushUrl(url) {
  return url.replace(/([?&])key=[^&]+/gi, '$1key=[REDACTED]');
}

function _semrushGetWithBackoff(url, attempt, resolve, reject) {
  const cfg = RETRY.semrush;

  const req = https.get(url, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      if (res.statusCode === 429) {
        if (attempt < cfg.maxRetries) {
          const d = cfg.delays[Math.min(attempt, cfg.delays.length - 1)];
          logger.warn(`Semrush 429, retry ${attempt + 1}/${cfg.maxRetries} dans ${d / 1000}s`);
          setTimeout(() => {
            lastRequestTime = Date.now();
            _semrushGetWithBackoff(url, attempt + 1, resolve, reject);
          }, d);
          return;
        }
        circuitBreakers.semrush.recordFailure();
        reject(new Error(`Semrush 429 apres ${cfg.maxRetries} retries`));
        return;
      }
      if (res.statusCode !== 200) {
        circuitBreakers.semrush.recordFailure();
        reject(new Error(`Semrush ${res.statusCode}: ${sanitizeErrorMessage(data.slice(0, 150))}`));
        return;
      }
      circuitBreakers.semrush.recordSuccess();
      resolve(data);
    });
    res.on('error', (e) => { circuitBreakers.semrush.recordFailure(); reject(new Error(`Semrush stream: ${sanitizeErrorMessage(e.message)}`)); });
  }).on('error', (e) => { circuitBreakers.semrush.recordFailure(); reject(new Error(`Semrush request: ${sanitizeErrorMessage(e.message)}`)); });
  req.setTimeout(TIMEOUTS.semrush, () => {
    req.destroy();
    circuitBreakers.semrush.recordFailure();
    reject(new Error(`Semrush timeout ${TIMEOUTS.semrush / 1000}s`));
  });
}

// ─── High-level API : request + CSV parsing ─────────────────────

function rateLimitedSemrushRequest(params) {
  // Pre-check: estimate max units (display_limit rows × 10 + base 10)
  const estimatedUnits = ((params.display_limit || 10) + 1) * 10;
  try { semrushSessionGuard(estimatedUnits); } catch (e) { return Promise.reject(e); }

  const query = new URLSearchParams(params).toString();
  return rateLimitedSemrushGet(`https://api.semrush.com/?${query}`).then(parseSemrushCSV);
}

function parseSemrushCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(';').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(';');
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] ? values[i].trim() : ''; });
    return row;
  });
}

// ─── Domain history validation ──────────────────────────────────

function validateSemrushData(domain, rowCount) {
  const history = readJSONSafe(PATHS.domainHistory, {});
  const prev = history[domain];
  const suspicious = prev && prev > 10 && rowCount < prev * 0.3;

  if (suspicious) {
    logger.warn(`ALERTE: ${domain} retourne ${rowCount} kws (precedent: ${prev}). Possible erreur API Semrush.`);
  }

  if (rowCount > 0) {
    history[domain] = rowCount;
    writeJSONAtomic(PATHS.domainHistory, history);
  }

  return !suspicious;
}

module.exports = {
  semrushSessionGuard,
  semrushSessionRecord,
  rateLimitedSemrushGet,
  rateLimitedSemrushRequest,
  parseSemrushCSV,
  validateSemrushData,
  SEMRUSH_SESSION_LIMIT,
};
