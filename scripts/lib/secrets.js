/**
 * lib/secrets.js
 * Chargement des secrets depuis secrets/<name>.json.
 *
 * Utilise PATHS.secrets pour localiser le repertoire. Aucun fallback :
 * si le fichier manque ou est invalide, on throw.
 */

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths');

function loadSecret(name) {
  const fp = path.join(PATHS.secrets, `${name}.json`);
  if (!fs.existsSync(fp)) throw new Error(`Secret not found: ${fp}`);
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) {
    throw new Error(`Invalid JSON in ${fp}: ${e.message}`);
  }
}

module.exports = { loadSecret };
