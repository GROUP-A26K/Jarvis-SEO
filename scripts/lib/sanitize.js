/**
 * lib/sanitize.js
 * HTML escape, sanitization de strings, slugs, filenames,
 * input LLM (prompt injection), messages d'erreur (fuite de secrets).
 *
 * Aucune dependance sur d'autres modules du projet.
 */

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitize(str) {
  return String(str || '')
    .replace(/[^\w\s\-\.àâäéèêëïîôùûüç]/gi, '')
    .trim();
}

function sanitizeFilename(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[éèêë]/g, 'e')
    .replace(/[àâä]/g, 'a')
    .replace(/[ùûü]/g, 'u')
    .replace(/[îï]/g, 'i')
    .replace(/[ôö]/g, 'o')
    .replace(/[ç]/g, 'c')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
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
    .replace(/token=[a-zA-Z0-9_.-]{10,}/gi, 'token=[REDACTED]')
    .replace(/sb_secret_[a-zA-Z0-9_-]{10,}/gi, '[REDACTED_SERVICE_KEY]')
    .replace(/sb_publishable_[a-zA-Z0-9_-]{10,}/gi, '[REDACTED_ANON_KEY]');
}

module.exports = {
  esc,
  sanitize,
  sanitizeFilename,
  sanitizeSlug,
  sanitizeArticleForLLM,
  sanitizeErrorMessage,
};
