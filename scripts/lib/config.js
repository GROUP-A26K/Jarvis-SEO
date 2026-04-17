/**
 * lib/config.js
 * Chargement et accesseurs de sites/config.json.
 *
 * Le cache _sitesConfigCache vit au niveau du module : une seule instance
 * partagee dans tout le process grace au cache de modules Node.
 * Utiliser invalidateSitesConfigCache() pour forcer un rechargement.
 *
 * Depend de paths.js (PATHS.sitesConfig) et logger.js.
 */

const fs = require('fs');
const { PATHS } = require('./paths');
const { logger } = require('./logger');

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

module.exports = {
  loadSitesConfig,
  getSiteConfig,
  getSiteList,
  getSiteLabels,
  invalidateSitesConfigCache,
  getConfigMeta,
  getSanityDefaults,
  getSanityDocType,
  getPersonaDetails,
  getSitePersonas,
  getSiteFallbackCompetitors,
  getSiteSources,
  getSiteEntity,
  getSiteFinma,
  getSiteStableSources,
  getSiteExhibitStyle,
};
