/**
 * lib/task-result.js
 * Contrat JSON pour les resultats du pipeline SEO.
 *
 * Permet a seo-publish-article.js d'ecrire son resultat final dans un
 * fichier JSON structure, et aux workflows (workflow-daily.js,
 * workflow-single-task.js) de le lire sans parser stdout.
 *
 * Depend de fs-utils (niveau 1) et logger (niveau 0). Niveau DAG : 2.
 *
 * Schema version : incrementer TASK_RESULT_SCHEMA_VERSION a chaque
 * changement de structure non-retrocompatible.
 */

const fs = require('fs');
const { writeJSONAtomic, readJSONSafe } = require('./fs-utils');
const { logger } = require('./logger');

const TASK_RESULT_SCHEMA_VERSION = '1.0.0';

// ─── Codes d'erreur standardises ────────────────────────────

const ERROR_CODES = {
  // Echecs d'integrations externes
  CLAUDE_CIRCUIT_OPEN: 'CLAUDE_CIRCUIT_OPEN',
  CLAUDE_API_FAILED: 'CLAUDE_API_FAILED',
  SEMRUSH_QUOTA_EXCEEDED: 'SEMRUSH_QUOTA_EXCEEDED',
  SEMRUSH_API_FAILED: 'SEMRUSH_API_FAILED',
  SANITY_PUBLISH_FAILED: 'SANITY_PUBLISH_FAILED',
  SANITY_UPLOAD_FAILED: 'SANITY_UPLOAD_FAILED',
  TAVILY_API_FAILED: 'TAVILY_API_FAILED',
  FLUX_API_FAILED: 'FLUX_API_FAILED',

  // Echecs de validation / logique
  DUPLICATE_KEYWORD: 'DUPLICATE_KEYWORD',
  INVALID_ARTICLE_JSON: 'INVALID_ARTICLE_JSON',
  VERIFIED_SOURCES_EMPTY: 'VERIFIED_SOURCES_EMPTY',
  IMAGE_INVALID: 'IMAGE_INVALID',

  // Echec generique / inconnu
  UNKNOWN: 'UNKNOWN',
};

// ─── Factory et I/O ──────────────────────────────────────────

/**
 * Initialise un objet TaskResult vide pour le debut d'une execution.
 * Les champs sanity, draft, heroImage, exhibits, etc. sont renseignes
 * au fur et a mesure par seo-publish-article.js.
 *
 * @param {object} params
 * @param {string} [params.taskId] - UUID de la jarvis_task (si applicable)
 * @param {string} params.site - Domaine du site (ex: 'assurance-genevoise.ch')
 * @param {string} params.keyword - Mot-cle / theme de l'article
 * @param {'publish'|'draft'} [params.mode='publish'] - Mode d'execution
 * @returns {object} TaskResult initialise
 */
function createTaskResult({ taskId = null, site, keyword, mode = 'publish' } = {}) {
  return {
    schemaVersion: TASK_RESULT_SCHEMA_VERSION,
    status: 'pending',
    taskId,
    site: site || null,
    keyword: keyword || null,
    mode,
    sanity: null,
    draft: null,
    heroImage: null,
    exhibits: [],
    contentUrl: null,
    scores: null,
    error: null,
    metadata: {
      startedAt: new Date().toISOString(),
      completedAt: null,
      durationSeconds: null,
    },
  };
}

/**
 * Ecrit un TaskResult dans un fichier JSON de maniere atomique.
 * Si resultPath est falsy, ne fait rien (backward-compat : --output-json absent).
 *
 * @param {string|null} resultPath - Chemin du fichier cible
 * @param {object} result - TaskResult a serialiser
 */
function writeTaskResult(resultPath, result) {
  if (!resultPath) return;
  try {
    writeJSONAtomic(resultPath, result);
  } catch (e) {
    logger.warn(`writeTaskResult echoue: ${resultPath}`, { error: e.message });
  }
}

/**
 * Lit un TaskResult depuis un fichier JSON.
 * Retourne null si le fichier est absent ou corrompu (le pipeline a crashe
 * avant d'ecrire, ou le fichier est incomplet).
 *
 * @param {string} resultPath - Chemin du fichier a lire
 * @returns {object|null} TaskResult lu, ou null
 */
function readTaskResult(resultPath) {
  if (!resultPath) return null;
  if (!fs.existsSync(resultPath)) return null;
  return readJSONSafe(resultPath, null);
}

/**
 * Marque un TaskResult comme succes et calcule la duree.
 * Ne persiste pas — appelez writeTaskResult separement.
 *
 * @param {object} result - TaskResult a finaliser
 * @returns {object} Le meme objet, mute avec status + completedAt + durationSeconds
 */
function finalizeSuccess(result) {
  const completedAt = new Date();
  result.status = 'success';
  result.metadata.completedAt = completedAt.toISOString();
  if (result.metadata.startedAt) {
    const startedAt = new Date(result.metadata.startedAt);
    result.metadata.durationSeconds = Math.round((completedAt - startedAt) / 1000);
  }
  return result;
}

/**
 * Marque un TaskResult comme erreur et calcule la duree.
 * Ne persiste pas — appelez writeTaskResult separement.
 *
 * @param {object} result - TaskResult a finaliser
 * @param {object} errorInfo
 * @param {string} errorInfo.code - Code dans ERROR_CODES
 * @param {string} errorInfo.message - Message lisible
 * @param {string} [errorInfo.stage] - Etape du pipeline ou l'erreur a eu lieu
 * @param {boolean} [errorInfo.retryable=false] - L'erreur est-elle transitoire ?
 * @returns {object} Le meme objet, mute avec status + error + completedAt
 */
function finalizeError(
  result,
  { code = ERROR_CODES.UNKNOWN, message = 'Unknown error', stage = null, retryable = false } = {},
) {
  const completedAt = new Date();
  result.status = 'error';
  result.error = { code, message, stage, retryable };
  result.metadata.completedAt = completedAt.toISOString();
  if (result.metadata.startedAt) {
    const startedAt = new Date(result.metadata.startedAt);
    result.metadata.durationSeconds = Math.round((completedAt - startedAt) / 1000);
  }
  return result;
}

module.exports = {
  TASK_RESULT_SCHEMA_VERSION,
  ERROR_CODES,
  createTaskResult,
  writeTaskResult,
  readTaskResult,
  finalizeSuccess,
  finalizeError,
};
