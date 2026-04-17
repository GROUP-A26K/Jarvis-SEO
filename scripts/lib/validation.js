/**
 * lib/validation.js
 * Validation d'inputs : article, site, persona, keyword.
 *
 * Depend de constants.js (VALID_PERSONAS) et config.js (getSiteList).
 */

const { VALID_PERSONAS } = require('./constants');
const { getSiteList } = require('./config');

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

module.exports = { validateArticleInput };
