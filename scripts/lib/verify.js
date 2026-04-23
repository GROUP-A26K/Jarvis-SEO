/**
 * lib/verify.js
 * Verification d'URL par requete HTTP GET.
 *
 * Retourne { url, status, ok } ou ok vaut true pour status 200-399.
 * Utilise GET plutot que HEAD car certains serveurs .ch rejettent HEAD (400/403).
 *
 * Depend de constants.js (TIMEOUTS).
 */

const http = require('http');
const https = require('https');
const { TIMEOUTS } = require('./constants');

function verifyUrl(url, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const proto = parsed.protocol === 'https:' ? https : http;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (compatible; JarvisBot/1.0)',
        Accept: 'text/html,application/xhtml+xml,*/*',
      };
      const req = proto.request(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: 'GET', // GET plutôt que HEAD — certains serveurs .ch rejettent HEAD (400/403)
          headers,
        },
        (res) => {
          res.resume(); // drain response body
          // 200-399 = ok (inclut les 301/302 redirects)
          resolve({
            url,
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 400,
          });
        },
      );
      req.on('error', () => resolve({ url, status: 0, ok: false }));
      req.setTimeout(timeoutMs || TIMEOUTS.urlVerify, () => {
        req.destroy();
        resolve({ url, status: 0, ok: false });
      });
      req.end();
    } catch {
      resolve({ url, status: 0, ok: false });
    }
  });
}

module.exports = { verifyUrl };
