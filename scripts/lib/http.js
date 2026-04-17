/**
 * lib/http.js
 * Client HTTP/HTTPS generique avec timeout et sanitization des erreurs.
 *
 * Retourne du JSON parse si possible, sinon le corps brut en string.
 * En cas de 4xx/5xx, rejette avec le statusCode + corps tronque et sanitize.
 *
 * Depend de constants.js (TIMEOUTS) et sanitize.js (sanitizeErrorMessage).
 */

const http = require('http');
const https = require('https');
const { TIMEOUTS } = require('./constants');
const { sanitizeErrorMessage } = require('./sanitize');

function httpRequest(url, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const proto = p.protocol === 'https:' ? https : http;
    const req = proto.request({
      hostname: p.hostname,
      port: p.port || undefined,
      path: p.pathname + p.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${sanitizeErrorMessage(data.slice(0, 300))}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || TIMEOUTS.http, () => {
      req.destroy();
      reject(new Error(`HTTP timeout ${opts.timeout || TIMEOUTS.http}ms: ${url}`));
    });
    if (opts.body) {
      const s = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      if (!req.getHeader('Content-Length')) {
        req.setHeader('Content-Length', Buffer.byteLength(s));
      }
      req.write(s);
    }
    req.end();
  });
}

module.exports = { httpRequest };
