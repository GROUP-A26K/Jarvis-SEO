/**
 * lib/paths.js
 * Chemins centralises vers les repertoires et fichiers du projet.
 *
 * Toutes les paths sont calculees a partir de ROOT_DIR (le repertoire
 * parent de scripts/). Importer PATHS depuis ici garantit que tous
 * les modules utilisent les memes chemins.
 */

const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');

const PATHS = {
  root: ROOT_DIR,
  scripts: path.join(ROOT_DIR, 'scripts'),
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

module.exports = { PATHS };
