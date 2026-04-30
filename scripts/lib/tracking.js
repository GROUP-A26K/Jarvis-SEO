/**
 * lib/tracking.js — Sprint M1 S1 refactor (append-only Supabase metrics_seo)
 *
 * Tracking d'articles via Supabase metrics_seo (append-only audit trail).
 * Units SEMrush (#27 dormante S1) reste JSON-based jusqu'à S2.
 *
 * Single-tenant A26K en S1 — client_id hardcoded constant default.
 * clientIdOverride optional param pour smoke tests / migrations futures multi-tenant.
 * Multi-tenant cleanup S2.1 (lookup table sites→client_id ou env var).
 *
 * Architecture append-only : chaque INSERT = nouvelle row immutable, read latest
 * snapshot via DISTINCT ON (article_id) ORDER BY measured_at DESC.
 * Voir D-2026-04-30-metrics-seo-append-only.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { PATHS } = require('./paths');
const { DEFAULT_PLAN_UNITS } = require('./constants');
const { logger } = require('./logger');
const { readJSONSafe, writeJSONAtomic, ensureDir } = require('./fs-utils');
const { acquireLock, withLockedJSON } = require('./locks');

// TODO S2.1 : replace by lookup table sites→client_id ou process.env.JARVIS_SEO_CLIENT_ID
const A26K_CLIENT_ID = '17c6c2c9-7e81-4291-aaf7-eecdc5e9ebe8';

let _supabaseClient = null;

/**
 * Lazy-load Supabase client singleton (service_role bypass RLS).
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function getSupabase() {
  if (_supabaseClient) return _supabaseClient;
  const secretPath = path.join(PATHS.secrets, 'supabase.json');
  if (!fs.existsSync(secretPath)) {
    throw new Error('secrets/supabase.json missing — required for tracking.js Supabase backend');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`secrets/supabase.json malformed JSON: ${message}`);
  }
  const url = parsed.url || parsed.SUPABASE_URL;
  const key = parsed.service_role_key || parsed.SUPABASE_SERVICE_KEY || parsed.serviceRoleKey;
  if (!url || !key) {
    throw new Error('Supabase credentials malformed (need url + service_role_key)');
  }
  _supabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  });
  return _supabaseClient;
}

// ─── SEMRUSH UNITS — UNCHANGED S1 (#27 dormante, branchement S2) ─────

function loadUnitsState() {
  return readJSONSafe(PATHS.semrushUnits, {
    planTotal: DEFAULT_PLAN_UNITS,
    consumed: 0,
    lastReset: new Date().toISOString().split('T')[0],
    history: [],
  });
}

function trackUnits(type, rowCount) {
  return withLockedJSON(
    PATHS.semrushUnits,
    {
      planTotal: DEFAULT_PLAN_UNITS,
      consumed: 0,
      lastReset: new Date().toISOString().split('T')[0],
      history: [],
    },
    (state) => {
      const today = new Date().toISOString().split('T')[0];
      if ((state.lastReset || '').slice(0, 7) !== today.slice(0, 7)) {
        state.consumed = 0;
        state.lastReset = today;
        state.history = [];
      }
      const units = Math.max(10, rowCount * 10);
      state.consumed += units;
      state.history.push({ date: new Date().toISOString(), type, rows: rowCount, units });
      const { semrushSessionRecord } = require('./semrush');
      semrushSessionRecord(units);
      if (state.history.length > 200) state.history = state.history.slice(-200);
      const remaining = state.planTotal - state.consumed;
      const pct = Math.round((state.consumed / state.planTotal) * 100);
      if (pct >= 80) {
        logger.warn(
          `SEMRUSH UNITS: ${state.consumed}/${state.planTotal} (${pct}%) — ${remaining} restantes`,
        );
      }
      return { consumed: state.consumed, remaining, percentUsed: pct, warning: pct >= 80 };
    },
  );
}

function printUnitsSummary() {
  const state = loadUnitsState();
  const pct = Math.min(100, Math.max(0, Math.round((state.consumed / state.planTotal) * 100)));
  const filled = Math.min(20, Math.round(pct / 5));
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  console.log(
    `\n  Semrush units: ${state.consumed.toLocaleString()}/${state.planTotal.toLocaleString()} [${bar}] ${pct}%`,
  );
  if (pct >= 80)
    console.log(`  ! ${(state.planTotal - state.consumed).toLocaleString()} restantes`);
}

// ─── TRACKED ARTICLES — Supabase metrics_seo append-only ──────────────

/**
 * INSERT initial article snapshot in metrics_seo (append-only).
 * Centralisé depuis seo-publish-article.js (refactor S1).
 *
 * @param {Object} data — article data
 * @param {Object} [options]
 * @param {string} [options.clientId] — override A26K_CLIENT_ID (smoke tests, multi-tenant futur)
 * @returns {Promise<void>}
 * @throws {Error} avec err.errorCode='SUPABASE_INSERT_FAILED' si INSERT fail
 */
async function trackArticle(data, options = {}) {
  const clientId = options.clientId || A26K_CLIENT_ID;
  const sb = getSupabase();
  const row = {
    article_id: data.id,
    client_id: clientId,
    site_slug: data.site,
    slug: data.slug,
    keyword: data.keyword,
    keyword_en: data.keywordEN || null,
    persona: data.persona,
    geo_score: data.geoScore,
    geo_status: data.geoStatus,
    geo_visibility: data.geoVisibility || null,
    published_at: data.publishedAt,
    j30_date: data.j30,
    j60_date: data.j60,
    j90_date: data.j90,
  };
  const { error } = await sb.from('metrics_seo').insert(row);
  if (error) {
    logger.error('trackArticle INSERT failed', { article_id: data.id, error: error.message });
    const wrapped = new Error(`Supabase trackArticle INSERT failed: ${error.message}`);
    wrapped.errorCode = 'SUPABASE_INSERT_FAILED';
    throw wrapped;
  }
}

/**
 * Read latest snapshot per article via client-side dedup (Option γ S1).
 * Fallback emergency lecture JSON_TRACKING si Supabase fail.
 *
 * TODO M2/M3 — replace client-side dedup by SQL VIEW metrics_seo_latest
 * (server-side DISTINCT ON via Postgres VIEW) when accumulated snapshots
 * exceed ~10k rows. Pattern : CREATE VIEW metrics_seo_latest AS
 * SELECT DISTINCT ON (client_id, article_id) * FROM metrics_seo
 * ORDER BY client_id, article_id, measured_at DESC.
 *
 * @param {Object} [options]
 * @param {string} [options.clientId] — override A26K_CLIENT_ID
 * @returns {Promise<Array<Object>>}
 */
async function loadTrackedArticles(options = {}) {
  const clientId = options.clientId || A26K_CLIENT_ID;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('metrics_seo')
      .select('*')
      .eq('client_id', clientId)
      .order('measured_at', { ascending: false });
    if (error) throw error;
    const seen = new Set();
    const latest = [];
    for (const row of data || []) {
      if (!seen.has(row.article_id)) {
        seen.add(row.article_id);
        latest.push(row);
      }
    }
    return latest;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('loadTrackedArticles failed, falling back to JSON', { error: message });
    return readJSONSafe(PATHS.jsonTracking, []);
  }
}

/**
 * INSERT new snapshot avec field updated, autres colonnes copiées du latest.
 * Append-only — préserve audit trail évolution positions J0/J30/J60/J90.
 *
 * @param {string} articleId
 * @param {string} field — position_j0|j30|j60|j90 ou geo_visibility
 * @param {number|string} value
 * @param {Object} [options]
 * @param {string} [options.clientId] — override A26K_CLIENT_ID
 * @returns {Promise<void>}
 */
async function updateArticleField(articleId, field, value, options = {}) {
  const clientId = options.clientId || A26K_CLIENT_ID;
  const ALLOWED_FIELDS = [
    'position_j0',
    'position_j30',
    'position_j60',
    'position_j90',
    'geo_visibility',
  ];
  if (!ALLOWED_FIELDS.includes(field)) {
    logger.warn(`updateArticleField: champ non autorise "${field}"`);
    return;
  }
  const sb = getSupabase();
  const { data: latest, error: readErr } = await sb
    .from('metrics_seo')
    .select('*')
    .eq('client_id', clientId)
    .eq('article_id', articleId)
    .order('measured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readErr) {
    logger.error('updateArticleField read latest failed', { articleId, error: readErr.message });
    throw new Error(`Read latest failed: ${readErr.message}`);
  }
  if (!latest) {
    logger.warn('updateArticleField: article inconnu', { articleId });
    return;
  }
  const newRow = {
    article_id: latest.article_id,
    client_id: latest.client_id,
    site_slug: latest.site_slug,
    slug: latest.slug,
    keyword: latest.keyword,
    keyword_en: latest.keyword_en,
    persona: latest.persona,
    geo_score: latest.geo_score,
    geo_status: latest.geo_status,
    geo_visibility: latest.geo_visibility,
    position_j0: latest.position_j0,
    position_j30: latest.position_j30,
    position_j60: latest.position_j60,
    position_j90: latest.position_j90,
    published_at: latest.published_at,
    j30_date: latest.j30_date,
    j60_date: latest.j60_date,
    j90_date: latest.j90_date,
    [field]: value,
  };
  const { error: insertErr } = await sb.from('metrics_seo').insert(newRow);
  if (insertErr) {
    logger.error('updateArticleField INSERT failed', {
      articleId,
      field,
      error: insertErr.message,
    });
    throw new Error(`INSERT new snapshot failed: ${insertErr.message}`);
  }
}

// ─── GAP ANALYSIS LOADER — UNCHANGED ──────────────────────────────────

function loadLatestGapAnalysis() {
  ensureDir(PATHS.reports);
  const files = fs
    .readdirSync(PATHS.reports)
    .filter((f) => f.startsWith('gap-analysis-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) return null;
  return readJSONSafe(path.join(PATHS.reports, files[0]), null);
}

// ─── PIPELINE STATE — UNCHANGED ───────────────────────────────────────

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

module.exports = {
  loadUnitsState,
  trackUnits,
  printUnitsSummary,
  loadTrackedArticles,
  updateArticleField,
  trackArticle,
  loadLatestGapAnalysis,
  loadPipelineState,
  savePipelineState,
};
