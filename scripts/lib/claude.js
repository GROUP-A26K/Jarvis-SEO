/**
 * lib/claude.js
 * Client Claude API avec retry, circuit breaker, extraction de texte.
 *
 * Note : n'utilise pas http.js mais https.request directement (historique,
 * pour garder le corps de reponse non-parse avant controle de taille).
 *
 * Depend de constants.js (CLAUDE_MODEL, DEFAULT_MAX_TOKENS, TIMEOUTS, RETRY),
 * logger.js, circuit.js (circuitBreakers.claude), sanitize.js.
 */

const https = require('https');
const { CLAUDE_MODEL, DEFAULT_MAX_TOKENS, TIMEOUTS, RETRY } = require('./constants');
const { logger } = require('./logger');
const { circuitBreakers } = require('./circuit');
const { sanitizeErrorMessage } = require('./sanitize');

function callClaudeWithRetry(apiKey, system, user, maxTokens, retries) {
  const cfg = RETRY.claude;
  const maxR = retries || cfg.maxRetries;

  // Circuit breaker check
  if (!circuitBreakers.claude.canExecute()) {
    return Promise.reject(
      new Error('Claude circuit breaker OUVERT — service temporairement indisponible'),
    );
  }

  function attempt(n) {
    return _callClaude(apiKey, system, user, maxTokens || DEFAULT_MAX_TOKENS)
      .then((result) => {
        circuitBreakers.claude.recordSuccess();
        return result;
      })
      .catch((err) => {
        const msg = err.message || '';
        const isRetryable =
          msg.includes('529') ||
          msg.includes('500') ||
          msg.includes('ECONNRESET') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('overloaded') ||
          msg.includes('timeout');
        if (n < maxR && isRetryable) {
          const delay = cfg.delays[Math.min(n, cfg.delays.length - 1)];
          logger.warn(
            `Claude API erreur (tentative ${n + 1}/${maxR}): ${msg}. Retry dans ${delay / 1000}s`,
          );
          return new Promise((resolve) => setTimeout(resolve, delay)).then(() => attempt(n + 1));
        }
        circuitBreakers.claude.recordFailure();
        throw err;
      });
  }

  return attempt(0);
}

function _callClaude(apiKey, system, user, maxTokens) {
  return new Promise((resolve, reject) => {
    // Support user comme string, array de content parts (multimodal) ou array de messages
    // - string → [{ role: 'user', content: string }]
    // - array de parts ({ type: ... }) → [{ role: 'user', content: [...parts] }]
    // - array de messages ({ role: ... }) → utilisé tel quel
    let messages;
    if (!Array.isArray(user)) {
      messages = [{ role: 'user', content: user }];
    } else if (user.length > 0 && user[0].role) {
      messages = user; // déjà formaté comme messages
    } else {
      messages = [{ role: 'user', content: user }]; // array de content parts → wrap
    }

    const bodyObj = {
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages,
    };
    if (system) bodyObj.system = system;

    const body = JSON.stringify(bodyObj);

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(
              new Error(`Claude ${res.statusCode}: ${sanitizeErrorMessage(data.slice(0, 200))}`),
            );
            return;
          }
          if (data.length > 5 * 1024 * 1024) {
            reject(
              new Error(`Claude reponse trop grande: ${(data.length / 1024 / 1024).toFixed(1)}MB`),
            );
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Claude response parse: ${e.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(TIMEOUTS.claude, () => {
      req.destroy();
      reject(new Error(`Claude API timeout ${TIMEOUTS.claude / 1000}s`));
    });
    req.write(body);
    req.end();
  });
}

function extractClaudeText(response) {
  const tc = response.content ? response.content.find((c) => c.type === 'text') : null;
  if (!tc) throw new Error('No text in Claude response');
  return tc.text;
}

module.exports = {
  callClaudeWithRetry,
  extractClaudeText,
};
