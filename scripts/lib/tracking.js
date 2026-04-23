/**
 * lib/tracking.js
 * Tracking d'articles (SQLite avec JSON fallback), units SEMrush,
 * gap analysis loader, pipeline state.
 *
 * Note : better-sqlite3 est require lazy (dans chaque fonction) pour
 * eviter le cout de chargement SQLite si non utilise.
 *
 * Note : trackUnits() appelle semrushSessionRecord() via un require lazy
 * vers lib/semrush.js, afin de rester en niveau 3 du DAG (semrush est niveau 4).
 *
 * Depend de paths.js, constants.js (DEFAULT_PLAN_UNITS), logger.js,
 * fs-utils.js, locks.js.
 */

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths');
const { DEFAULT_PLAN_UNITS } = require('./constants');
const { logger } = require('./logger');
const { readJSONSafe, writeJSONAtomic, ensureDir } = require('./fs-utils');
const { acquireLock, withLockedJSON } = require('./locks');

// ─── SEMRUSH UNITS ──────────────────────────────────────────────

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
      // Session guard — compteur en mémoire (protection anti-boucle)
      // Lazy require pour eviter un cycle niveau 3 -> niveau 4
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
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(20 - filled);
  console.log(
    `\n  Semrush units: ${state.consumed.toLocaleString()}/${state.planTotal.toLocaleString()} [${bar}] ${pct}%`,
  );
  if (pct >= 80)
    console.log(`  ! ${(state.planTotal - state.consumed).toLocaleString()} restantes`);
}

// ─── TRACKED ARTICLES (SQLite + JSON fallback) ──────────────────

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

// ─── GAP ANALYSIS LOADER ────────────────────────────────────────

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

// ─── PIPELINE STATE ─────────────────────────────────────────────

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
  loadLatestGapAnalysis,
  loadPipelineState,
  savePipelineState,
};
