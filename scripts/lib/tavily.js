/**
 * lib/tavily.js
 * Recherche web via l'API Tavily pour sources d'articles.
 *
 * Retourne un tableau vide en cas d'erreur (pas de throw) : Tavily est
 * non-critique, l'article peut etre genere sans sources externes.
 *
 * Le timeout de 15s est hardcode (historique, non configurable via TIMEOUTS).
 *
 * Depend de logger.js et env.js (getApiKey).
 */

const https = require('https');
const { logger } = require('./logger');
const { getApiKey } = require('./env');

/**
 * Search the web via Tavily API and return relevant URLs for a given query.
 * @param {string} query - Search query
 * @param {object} opts - { maxResults, includeDomains, searchDepth }
 * @returns {Promise<Array<{url, title, content}>>}
 */
function tavilySearch(query, opts) {
  const tavilyKey = getApiKey('TAVILY_API_KEY', 'tavily', 'api_key');
  if (!tavilyKey) return Promise.resolve([]);

  const options = opts || {};
  const body = JSON.stringify({
    api_key: tavilyKey,
    query,
    search_depth: options.searchDepth || 'basic',
    max_results: options.maxResults || 8,
    include_domains: options.includeDomains || [],
    exclude_domains: ['youtube.com', 'facebook.com', 'twitter.com', 'instagram.com', 'tiktok.com'],
    include_answer: false,
    include_raw_content: false,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.tavily.com',
      path: '/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          logger.warn(`Tavily ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve([]);
          return;
        }
        try {
          const resp = JSON.parse(data);
          const results = (resp.results || []).map((r) => ({
            url: r.url,
            title: r.title || '',
            content: r.content || '',
          })).filter((r) => r.url && r.url.startsWith('https://'));
          resolve(results);
        } catch (e) {
          logger.warn(`Tavily parse error: ${e.message}`);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => { logger.warn(`Tavily error: ${e.message}`); resolve([]); });
    req.setTimeout(15000, () => { req.destroy(); logger.warn('Tavily timeout'); resolve([]); });
    req.write(body);
    req.end();
  });
}

module.exports = { tavilySearch };
