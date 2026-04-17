/**
 * lib/env.js
 * Validation des variables d'environnement + chargement des cles API
 * avec fallback vers secrets/<name>.json.
 *
 * Depend de logger.js (logs d'erreur/warning) et secrets.js (fallback fichier).
 */

const { logger } = require('./logger');
const { loadSecret } = require('./secrets');

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

module.exports = {
  validateEnv,
  getApiKey,
  requireAnthropicKey,
};
