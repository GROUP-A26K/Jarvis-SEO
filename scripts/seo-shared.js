/**
 * seo-shared.js v3
 * Module central : toutes les fonctions partagees.
 *
 * - Logger structure (info/warn/error)
 * - Paths et constantes centralisees
 * - Config sites dynamique (sites/config.json)
 * - Secrets loader
 * - Env validation
 * - File I/O atomique + file-lock simple
 * - HTTP request generique
 * - HTML escape
 * - Sanitization (slug, filename, LLM input)
 * - Semrush rate limiter, units tracker, data validation
 * - Claude API retry (texte + vision)
 * - URL verification
 * - SQLite/JSON tracking (read/write)
 * - Gap analysis loader
 * - Pipeline state
 * - Email (Resend)
 * - Input validation
 * - ISO week
 *
 * Jarvis One — Groupe Genevoise
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ═══════════════════════════════════════════════════════════════
// PATHS CENTRALISEES
// ═══════════════════════════════════════════════════════════════

const ROOT_DIR = path.join(__dirname, '..');
const PATHS = {
  root: ROOT_DIR,
  scripts: __dirname,
  secrets: path.join(ROOT_DIR, 'secrets'),
  data: path.join(ROOT_DIR, 'data'),
  reports: path.join(ROOT_DIR, 'reports'),
  images: path.join(ROOT_DIR, 'images'),
  sites: path.join(ROOT_DIR, 'sites'),
  db: path.join(ROOT_DIR, 'data', 'seo-tracking.db'),
  jsonTracking: path.join(ROOT_DIR, 'data', 'articles-tracking.json'),
  pipelineState: path.join(ROOT_DIR, 'data', 'pipeline-state.json'),
  semrushUnits: path.join(ROOT_DIR, 'data', 'semrush-units.json'),
  domainHistory: path.join(ROOT_DIR, 'data', 'semrush-domain-history.json'),
  sitesConfig: path.join(ROOT_DIR, 'sites', 'config.json'),
};

// ═══════════════════════════════════════════════════════════════
// CONSTANTES CENTRALISEES
// ═══════════════════════════════════════════════════════════════

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 8000;
const CLAUDE_TIMEOUT_MS = 180000;

const EMAIL_RECIPIENTS = ['jeanbaptiste@a26k.ch', 'benjamin@a26k.ch'];
const MAX_ARTICLES_PER_WEEK = 5;

const DEFAULT_PLAN_UNITS = 50000;
const SEMRUSH_INTERVAL_MS = 125;

const VALID_PERSONAS = [
  'Hugo Schaller', 'Amelie Bonvin', 'Marc Favre', 'Elodie Rochat',
  'Lucas Morel', 'Sofia Meier', 'Philippe Dufour', 'Nathalie Berger',
];

// ─── Timeouts configurables ─────────────────────────────────
const TIMEOUTS = {
  claude: CLAUDE_TIMEOUT_MS,     // 180s — LLM calls
  semrush: 15000,                // 15s — API Semrush
  sanity: 30000,                 // 30s — Sanity CMS
  flux: 60000,                   // 60s — Flux image generation
  http: 30000,                   // 30s — generic HTTP
  urlVerify: 5000,               // 5s — HEAD request verification
  fileLock: 5000,                // 5s — advisory file lock
  gsc: 20000,                    // 20s — Google Search Console
  email: 15000,                  // 15s — Resend email
};

// ─── Retry configurables ────────────────────────────────────
const RETRY = {
  claude:  { maxRetries: 3, delays: [1000, 3000, 9000] },
  semrush: { maxRetries: 3, delays: [2000, 4000, 8000] },
  flux:    { maxRetries: 3, delays: [1000, 2000, 4000] },
  http:    { maxRetries: 2, delays: [1000, 3000] },
};

// ═══════════════════════════════════════════════════════════════
// CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════════════
// Apres N echecs consecutifs sur un service, le breaker s'ouvre
// et bloque les appels pendant un cooldown. Cela evite de
// spammer un service en panne et de gaspiller du budget.

const _circuitState = {};

function createCircuitBreaker(serviceName, opts) {
  const threshold = (opts && opts.threshold) || 5;
  const cooldownMs = (opts && opts.cooldownMs) || 60000;

  if (!_circuitState[serviceName]) {
    _circuitState[serviceName] = {
      failures: 0,
      lastFailure: 0,
      state: 'closed', // closed=normal, open=blocked, half-open=testing
    };
  }

  return {
    get state() { return _circuitState[serviceName].state; },

    /** Verifie si le circuit autorise un appel */
    canExecute() {
      const s = _circuitState[serviceName];
      if (s.state === 'closed') return true;
      if (s.state === 'open') {
        // Check if cooldown has elapsed
        if (Date.now() - s.lastFailure > cooldownMs) {
          s.state = 'half-open';
          return true;
        }
        return false;
      }
      // half-open: allow one test call
      return true;
    },

    /** Signale un succes — reset le compteur */
    recordSuccess() {
      const s = _circuitState[serviceName];
      s.failures = 0;
      s.state = 'closed';
    },

    /** Signale un echec — incremente et ouvre si seuil atteint */
    recordFailure() {
      const s = _circuitState[serviceName];
      s.failures++;
      s.lastFailure = Date.now();
      if (s.failures >= threshold) {
        s.state = 'open';
        logger.warn(`Circuit breaker OUVERT: ${serviceName} (${s.failures} echecs consecutifs). Cooldown ${cooldownMs / 1000}s`);
      }
    },

    /** Reset force */
    reset() {
      _circuitState[serviceName] = { failures: 0, lastFailure: 0, state: 'closed' };
    },
  };
}

// Pre-create breakers for external services
const circuitBreakers = {
  claude: createCircuitBreaker('claude', { threshold: 5, cooldownMs: 60000 }),
  semrush: createCircuitBreaker('semrush', { threshold: 5, cooldownMs: 120000 }),
  flux: createCircuitBreaker('flux', { threshold: 3, cooldownMs: 60000 }),
  sanity: createCircuitBreaker('sanity', { threshold: 3, cooldownMs: 60000 }),
  gemini: createCircuitBreaker('gemini', { threshold: 3, cooldownMs: 60000 }),
};

// ═══════════════════════════════════════════════════════════════
// LOGGER STRUCTURE
// ═══════════════════════════════════════════════════════════════

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let _logLevel = LOG_LEVELS.info;

const logger = {
  setLevel(level) {
    _logLevel = LOG_LEVELS[level] || LOG_LEVELS.info;
  },

  _format(level, msg, ctx) {
    const ts = new Date().toISOString();
    const icon = { debug: '.', info: '+', warn: '!', error: 'X' }[level] || ' ';
    const ctxStr = ctx ? ` ${JSON.stringify(ctx)}` : '';
    return `  ${icon} ${msg}${ctxStr}`;
  },

  debug(msg, ctx) {
    if (_logLevel <= LOG_LEVELS.debug) console.log(this._format('debug', msg, ctx));
  },
  info(msg, ctx) {
    if (_logLevel <= LOG_LEVELS.info) console.log(this._format('info', msg, ctx));
  },
  warn(msg, ctx) {
    if (_logLevel <= LOG_LEVELS.warn) console.warn(this._format('warn', msg, ctx));
  },
  error(msg, ctx) {
    if (_logLevel <= LOG_LEVELS.error) console.error(this._format('error', msg, ctx));
  },
};

// ═══════════════════════════════════════════════════════════════
// ENV VALIDATION
// ═══════════════════════════════════════════════════════════════

function validateEnv(required, optional) {
  const missing = [];
  const warnings = [];

  for (const key of required || []) {
    if (!process.env[key] || process.env[key].trim() === '') {
      missing.push(key);
    }
  }
  for (const key of optional || []) {
    if (!process.env[key] || process.env[key].trim() === '') {
      warnings.push(key);
    }
  }

  if (missing.length > 0) {
    logger.error(`Variables d'environnement manquantes: ${missing.join(', ')}`);
  }
  if (warnings.length > 0) {
    logger.warn(`Variables d'environnement optionnelles absentes: ${warnings.join(', ')}`);
  }

  return { valid: missing.length === 0, missing, warnings };
}

/**
 * Charge une cle API : essaie process.env d'abord, puis secrets/{name}.json.
 * Centralise le pattern env-or-file pour toutes les cles.
 * @param {string} envVar - Nom de la variable d'environnement (ex: 'ANTHROPIC_API_KEY')
 * @param {string} secretName - Nom du fichier secret (ex: 'anthropic')
 * @param {string} secretField - Champ dans le JSON (ex: 'api_key')
 * @returns {string|null} La cle ou null si introuvable
 */
function getApiKey(envVar, secretName, secretField) {
  // 1. Variable d'environnement
  const envVal = process.env[envVar];
  if (envVal && envVal.trim()) return envVal.trim();

  // 2. Fichier secret
  try {
    const secret = loadSecret(secretName);
    const val = secret[secretField];
    if (val && String(val).trim()) {
      logger.debug(`${envVar} charge depuis secrets/${secretName}.json`);
      return String(val).trim();
    }
  } catch {
    // Fichier absent ou invalide — pas d'erreur, on retourne null
  }

  return null;
}

/**
 * Charge la cle Anthropic (env ou secrets/anthropic.json).
 * @returns {string} La cle API
 * @throws {Error} Si la cle est introuvable
 */
function requireAnthropicKey() {
  const key = getApiKey('ANTHROPIC_API_KEY', 'anthropic', 'api_key');
  if (!key) throw new Error('ANTHROPIC_API_KEY manquante (env ou secrets/anthropic.json)');
  return key;
}

// ═══════════════════════════════════════════════════════════════
// FILE I/O UTILITAIRES
// ═══════════════════════════════════════════════════════════════

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeFileAtomic(filePath, data) {
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJSONSafe(filePath, defaultVal) {
  if (!fs.existsSync(filePath)) return defaultVal;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    logger.warn(`JSON corrompu: ${filePath}`, { error: e.message });
    try { fs.renameSync(filePath, `${filePath}.bak.${Date.now()}`); } catch (bErr) {
      logger.warn(`Backup fichier corrompu echoue`, { error: bErr.message });
    }
    return defaultVal;
  }
}

function writeJSONAtomic(filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2) + '\n');
}

// ─── File Lock simple (advisory, .lock files) ────────────────

const _activeLocks = new Set();

function acquireLock(filePath, timeoutMs) {
  const lockPath = `${filePath}.lock`;
  const timeout = timeoutMs || TIMEOUTS.fileLock;
  const start = Date.now();

  while (fs.existsSync(lockPath)) {
    try {
      const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (lockAge > 30000) {
        logger.warn(`Lock stale supprime: ${lockPath}`, { age_ms: lockAge });
        try { fs.unlinkSync(lockPath); } catch { /* race ok */ }
        break;
      }
    } catch { break; }

    if (Date.now() - start > timeout) {
      throw new Error(`Lock timeout sur ${filePath} (${timeout}ms)`);
    }
    const waitUntil = Date.now() + 50;
    while (Date.now() < waitUntil) { /* spin */ }
  }

  try {
    fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: 'wx' });
  } catch {
    throw new Error(`Lock concurrent sur ${filePath}`);
  }

  _activeLocks.add(lockPath);

  return function release() {
    try { fs.unlinkSync(lockPath); } catch { /* deja supprime */ }
    _activeLocks.delete(lockPath);
  };
}

function withLockedJSON(filePath, defaultVal, mutator) {
  const release = acquireLock(filePath);
  try {
    const data = readJSONSafe(filePath, defaultVal);
    const result = mutator(data);
    writeJSONAtomic(filePath, data);
    return result;
  } finally {
    release();
  }
}

function cleanupLocks() {
  for (const lockPath of _activeLocks) {
    try { fs.unlinkSync(lockPath); } catch { /* ok */ }
  }
  _activeLocks.clear();
}
process.on('exit', cleanupLocks);
process.on('SIGINT', () => { cleanupLocks(); process.exit(130); });
process.on('SIGTERM', () => { cleanupLocks(); process.exit(143); });
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  cleanupLocks();
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack ? err.stack.split('\n').slice(0, 3).join(' ') : '' });
  cleanupLocks();
  process.exit(1);
});

// ═══════════════════════════════════════════════════════════════
// SECRETS
// ═══════════════════════════════════════════════════════════════

function loadSecret(name) {
  const fp = path.join(PATHS.secrets, `${name}.json`);
  if (!fs.existsSync(fp)) throw new Error(`Secret not found: ${fp}`);
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) {
    throw new Error(`Invalid JSON in ${fp}: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// SITES CONFIG DYNAMIQUE
// ═══════════════════════════════════════════════════════════════

let _sitesConfigCache = null;

function loadSitesConfig() {
  if (_sitesConfigCache) return _sitesConfigCache;
  try {
    _sitesConfigCache = JSON.parse(fs.readFileSync(PATHS.sitesConfig, 'utf-8'));
  } catch (e) {
    logger.error(`Impossible de charger sites/config.json`, { error: e.message });
    _sitesConfigCache = {};
  }
  return _sitesConfigCache;
}

function getSiteConfig(site) {
  return loadSitesConfig()[site] || null;
}

function getSiteList() {
  return Object.keys(loadSitesConfig()).filter((k) => !k.startsWith('_'));
}

function getSiteLabels() {
  const config = loadSitesConfig();
  const labels = {};
  for (const [site, data] of Object.entries(config)) {
    if (site.startsWith('_')) continue;
    labels[site] = data.label || site;
  }
  return labels;
}

function invalidateSitesConfigCache() {
  _sitesConfigCache = null;
}

/**
 * Returns the _meta block from config (sanity defaults, persona details).
 */
function getConfigMeta() {
  const config = loadSitesConfig();
  return config._meta || {};
}

/**
 * Returns Sanity defaults (projectId, dataset, apiVersion, default IDs).
 */
function getSanityDefaults() {
  const meta = getConfigMeta();
  return meta.sanityDefaults || {};
}

/**
 * Returns the Sanity document type for a given site.
 */
function getSanityDocType(site) {
  const config = getSiteConfig(site);
  if (config && config.sanity && config.sanity.documentType) return config.sanity.documentType;
  // Fallback: generate from site name
  return site.replace(/[-\.]/g, '') + 'BlogPost';
}

/**
 * Returns persona details (style) from the _meta block.
 */
function getPersonaDetails(personaName) {
  const meta = getConfigMeta();
  const details = (meta.personasDetails || {})[personaName];
  return details || { style: '' };
}

/**
 * Returns the list of personas for a site.
 */
function getSitePersonas(site) {
  const config = getSiteConfig(site);
  return (config && config.personas) || [];
}

/**
 * Returns fallback competitors for a site.
 */
function getSiteFallbackCompetitors(site) {
  const config = getSiteConfig(site);
  return (config && config.fallbackCompetitors) || [];
}

/**
 * Returns site sources string.
 */
function getSiteSources(site) {
  const config = getSiteConfig(site);
  return (config && config.sources) || '';
}

/**
 * Returns the legal entity name for a site.
 */
function getSiteEntity(site) {
  const config = getSiteConfig(site);
  return (config && config.entity) || site;
}

/**
 * Returns the FINMA registration for a site, or null.
 */
function getSiteFinma(site) {
  const config = getSiteConfig(site);
  return (config && config.finma) || null;
}

/**
 * Returns verified stable source URLs for a site.
 */
function getSiteStableSources(site) {
  const config = getSiteConfig(site);
  return (config && config.sources_stables) || [];
}

/**
 * Returns the exhibit style config for a site (accent colors, Gemini directive).
 */
function getSiteExhibitStyle(site) {
  const config = getSiteConfig(site);
  return (config && config.exhibitStyle) || { accentColor: '#1a1a2e', accentColorLight: '#f0f0f0', geminiDirective: '' };
}

// ═══════════════════════════════════════════════════════════════
// HTTP REQUEST GENERIQUE
// ═══════════════════════════════════════════════════════════════

function httpRequest(url, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const proto = p.protocol === 'https:' ? https : http;
    const req = proto.request({
      hostname: p.hostname,
      port: p.port || undefined,
      path: p.pathname + p.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${sanitizeErrorMessage(data.slice(0, 300))}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || TIMEOUTS.http, () => {
      req.destroy();
      reject(new Error(`HTTP timeout ${opts.timeout || TIMEOUTS.http}ms: ${url}`));
    });
    if (opts.body) {
      const s = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      if (!req.getHeader('Content-Length')) {
        req.setHeader('Content-Length', Buffer.byteLength(s));
      }
      req.write(s);
    }
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// HTML ESCAPE
// ═══════════════════════════════════════════════════════════════

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════════════
// SANITIZATION
// ═══════════════════════════════════════════════════════════════

function sanitize(str) {
  return String(str || '').replace(/[^\w\s\-\.àâäéèêëïîôùûüç]/gi, '').trim();
}

function sanitizeFilename(str) {
  return String(str || '').toLowerCase()
    .replace(/[éèêë]/g, 'e').replace(/[àâä]/g, 'a').replace(/[ùûü]/g, 'u')
    .replace(/[îï]/g, 'i').replace(/[ôö]/g, 'o').replace(/[ç]/g, 'c')
    .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 60);
}

function sanitizeSlug(str) {
  return sanitizeFilename(str);
}

function sanitizeArticleForLLM(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/system:|assistant:|<\|im_start\|>|<\|im_end\|>/gi, '[STRIPPED]')
    .slice(0, 15000);
}

/**
 * Supprime les cles API et tokens des messages d'erreur pour eviter les fuites.
 */
function sanitizeErrorMessage(msg) {
  return String(msg || '')
    .replace(/key=[a-zA-Z0-9_-]{10,}/gi, 'key=[REDACTED]')
    .replace(/Bearer [a-zA-Z0-9_.-]{10,}/gi, 'Bearer [REDACTED]')
    .replace(/x-api-key:\s*[a-zA-Z0-9_-]{10,}/gi, 'x-api-key: [REDACTED]')
    .replace(/token=[a-zA-Z0-9_.-]{10,}/gi, 'token=[REDACTED]');
}

// ═══════════════════════════════════════════════════════════════
// SEMRUSH RATE LIMITER (8 req/s, retry 429 avec backoff)
// ═══════════════════════════════════════════════════════════════

let lastRequestTime = 0;
let requestQueue = Promise.resolve();

function rateLimitedSemrushGet(url) {
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
    res.on('error', (e) => { circuitBreakers.semrush.recordFailure(); reject(e); });
  }).on('error', (e) => { circuitBreakers.semrush.recordFailure(); reject(e); });
  req.setTimeout(TIMEOUTS.semrush, () => {
    req.destroy();
    circuitBreakers.semrush.recordFailure();
    reject(new Error(`Semrush timeout ${TIMEOUTS.semrush / 1000}s`));
  });
}

function rateLimitedSemrushRequest(params) {
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

// ═══════════════════════════════════════════════════════════════
// SEMRUSH DATA VALIDATION
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// SEMRUSH UNITS TRACKER
// ═══════════════════════════════════════════════════════════════

function loadUnitsState() {
  return readJSONSafe(PATHS.semrushUnits, {
    planTotal: DEFAULT_PLAN_UNITS,
    consumed: 0,
    lastReset: new Date().toISOString().split('T')[0],
    history: [],
  });
}

function trackUnits(type, rowCount) {
  return withLockedJSON(PATHS.semrushUnits, {
    planTotal: DEFAULT_PLAN_UNITS, consumed: 0,
    lastReset: new Date().toISOString().split('T')[0], history: [],
  }, (state) => {
    const today = new Date().toISOString().split('T')[0];
    if ((state.lastReset || '').slice(0, 7) !== today.slice(0, 7)) {
      state.consumed = 0;
      state.lastReset = today;
      state.history = [];
    }
    const units = Math.max(10, rowCount * 10);
    state.consumed += units;
    state.history.push({ date: new Date().toISOString(), type, rows: rowCount, units });
    if (state.history.length > 200) state.history = state.history.slice(-200);

    const remaining = state.planTotal - state.consumed;
    const pct = Math.round(state.consumed / state.planTotal * 100);
    if (pct >= 80) {
      logger.warn(`SEMRUSH UNITS: ${state.consumed}/${state.planTotal} (${pct}%) — ${remaining} restantes`);
    }
    return { consumed: state.consumed, remaining, percentUsed: pct, warning: pct >= 80 };
  });
}

function printUnitsSummary() {
  const state = loadUnitsState();
  const pct = Math.min(100, Math.max(0, Math.round(state.consumed / state.planTotal * 100)));
  const filled = Math.min(20, Math.round(pct / 5));
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(20 - filled);
  console.log(`\n  Semrush units: ${state.consumed.toLocaleString()}/${state.planTotal.toLocaleString()} [${bar}] ${pct}%`);
  if (pct >= 80) console.log(`  ! ${(state.planTotal - state.consumed).toLocaleString()} restantes`);
}

// ═══════════════════════════════════════════════════════════════
// CLAUDE API WITH RETRY
// ═══════════════════════════════════════════════════════════════

function callClaudeWithRetry(apiKey, system, user, maxTokens, retries) {
  const cfg = RETRY.claude;
  const maxR = retries || cfg.maxRetries;

  // Circuit breaker check
  if (!circuitBreakers.claude.canExecute()) {
    return Promise.reject(new Error('Claude circuit breaker OUVERT — service temporairement indisponible'));
  }

  function attempt(n) {
    return _callClaude(apiKey, system, user, maxTokens || DEFAULT_MAX_TOKENS).then((result) => {
      circuitBreakers.claude.recordSuccess();
      return result;
    }).catch((err) => {
      const msg = err.message || '';
      const isRetryable = msg.includes('529') || msg.includes('500') ||
        msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') ||
        msg.includes('overloaded') || msg.includes('timeout');
      if (n < maxR && isRetryable) {
        const delay = cfg.delays[Math.min(n, cfg.delays.length - 1)];
        logger.warn(`Claude API erreur (tentative ${n + 1}/${maxR}): ${msg}. Retry dans ${delay / 1000}s`);
        return new Promise((resolve) => setTimeout(resolve, delay)).then(() => attempt(n + 1));
      }
      circuitBreakers.claude.recordFailure();
      throw err;
    });
  }

  return attempt(0);
}

function _callClaude(apiKey, system, user, maxTokens) {
  return new Promise((resolve, reject) => {
    // Support user comme string (texte) ou array (multimodal/vision)
    const messages = Array.isArray(user)
      ? user
      : [{ role: 'user', content: user }];

    const bodyObj = {
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages,
    };
    if (system) bodyObj.system = system;

    const body = JSON.stringify(bodyObj);

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Claude ${res.statusCode}: ${sanitizeErrorMessage(data.slice(0, 200))}`));
          return;
        }
        if (data.length > 5 * 1024 * 1024) {
          reject(new Error(`Claude reponse trop grande: ${(data.length / 1024 / 1024).toFixed(1)}MB`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Claude response parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUTS.claude, () => {
      req.destroy();
      reject(new Error(`Claude API timeout ${TIMEOUTS.claude / 1000}s`));
    });
    req.write(body);
    req.end();
  });
}

function extractClaudeText(response) {
  const tc = response.content ? response.content.find((c) => c.type === 'text') : null;
  if (!tc) throw new Error('No text in Claude response');
  return tc.text;
}

// ═══════════════════════════════════════════════════════════════
// URL VERIFICATION (HEAD request)
// ═══════════════════════════════════════════════════════════════

function verifyUrl(url, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const proto = parsed.protocol === 'https:' ? https : http;
      const req = proto.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'HEAD',
      }, (res) => {
        resolve({ url, status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 400 });
      });
      req.on('error', () => resolve({ url, status: 0, ok: false }));
      req.setTimeout(timeoutMs || TIMEOUTS.urlVerify, () => {
        req.destroy();
        resolve({ url, status: 0, ok: false });
      });
      req.end();
    } catch {
      resolve({ url, status: 0, ok: false });
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// TRACKING (SQLite + JSON fallback)
// ═══════════════════════════════════════════════════════════════

function loadTrackedArticles() {
  try {
    const D = require('better-sqlite3');
    if (fs.existsSync(PATHS.db)) {
      const db = new D(PATHS.db, { readonly: true });
      const rows = db.prepare('SELECT * FROM articles ORDER BY published_at DESC').all();
      db.close();
      return rows;
    }
  } catch (e) {
    logger.debug('SQLite non disponible pour lecture tracking', { error: e.message });
  }
  return readJSONSafe(PATHS.jsonTracking, []);
}

function updateArticleField(articleId, field, value) {
  // Mapping statique — pas d'interpolation SQL
  const QUERIES = {
    position_j0: 'UPDATE articles SET position_j0 = ? WHERE id = ?',
    position_j30: 'UPDATE articles SET position_j30 = ? WHERE id = ?',
    position_j60: 'UPDATE articles SET position_j60 = ? WHERE id = ?',
    position_j90: 'UPDATE articles SET position_j90 = ? WHERE id = ?',
    geo_visibility: 'UPDATE articles SET geo_visibility = ? WHERE id = ?',
  };

  const query = QUERIES[field];
  if (!query) {
    logger.warn(`updateArticleField: champ non autorise "${field}"`);
    return;
  }

  try {
    const D = require('better-sqlite3');
    if (fs.existsSync(PATHS.db)) {
      const db = new D(PATHS.db);
      db.prepare(query).run(value, articleId);
      db.close();
      return;
    }
  } catch (e) {
    logger.debug('SQLite non disponible pour update tracking', { error: e.message });
  }

  // JSON fallback avec lock
  if (fs.existsSync(PATHS.jsonTracking)) {
    try {
      withLockedJSON(PATHS.jsonTracking, [], (arts) => {
        const art = arts.find((a) => a.id === articleId);
        if (art) art[field] = value;
      });
    } catch (e) {
      logger.error(`updateArticleField JSON echoue`, { articleId, field, error: e.message });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// GAP ANALYSIS LOADER
// ═══════════════════════════════════════════════════════════════

function loadLatestGapAnalysis() {
  ensureDir(PATHS.reports);
  const files = fs.readdirSync(PATHS.reports)
    .filter((f) => f.startsWith('gap-analysis-') && f.endsWith('.json'))
    .sort().reverse();
  if (!files.length) return null;
  return readJSONSafe(path.join(PATHS.reports, files[0]), null);
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE STATE
// ═══════════════════════════════════════════════════════════════

function loadPipelineState() {
  return readJSONSafe(PATHS.pipelineState, null);
}

function savePipelineState(state) {
  const release = acquireLock(PATHS.pipelineState);
  try {
    writeJSONAtomic(PATHS.pipelineState, state);
  } finally {
    release();
  }
}

// ═══════════════════════════════════════════════════════════════
// EMAIL (via Resend)
// ═══════════════════════════════════════════════════════════════

async function sendEmail(subject, html, attachments) {
  const resend = loadSecret('resend');
  const payload = { from: resend.from, to: EMAIL_RECIPIENTS, subject, html };
  if (attachments) payload.attachments = attachments;
  return httpRequest('https://api.resend.com/emails', {
    method: 'POST',
    timeout: TIMEOUTS.email,
    headers: {
      Authorization: `Bearer ${resend.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

// ═══════════════════════════════════════════════════════════════
// INPUT VALIDATION
// ═══════════════════════════════════════════════════════════════

function validateArticleInput(art) {
  const sites = getSiteList();
  const errors = [];
  if (!art.site || !sites.includes(art.site)) errors.push(`site invalide: "${art.site}"`);
  if (!art.keyword || typeof art.keyword !== 'string') errors.push('keyword manquant');
  if (art.keyword && /[;|&`$(){}\\]/.test(art.keyword)) errors.push(`keyword contient des caracteres interdits: "${art.keyword}"`);
  if (art.keyword && art.keyword.length > 100) errors.push('keyword trop long (max 100)');
  if (art.persona && !VALID_PERSONAS.includes(art.persona)) errors.push(`persona invalide: "${art.persona}"`);
  return errors;
}

// ═══════════════════════════════════════════════════════════════
// ISO WEEK
// ═══════════════════════════════════════════════════════════════

function getISOWeek(d) {
  const date = d ? new Date(d) : new Date();
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dn = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dn);
  const ys = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return `${utc.getUTCFullYear()}-W${String(Math.ceil(((utc - ys) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
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
  rateLimitedSemrushGet, rateLimitedSemrushRequest, parseSemrushCSV,
  validateSemrushData, trackUnits, printUnitsSummary, loadUnitsState,
  callClaudeWithRetry, extractClaudeText,
  verifyUrl,
  loadTrackedArticles, updateArticleField,
  loadLatestGapAnalysis, loadPipelineState, savePipelineState,
  sendEmail, validateArticleInput, getISOWeek,
};
