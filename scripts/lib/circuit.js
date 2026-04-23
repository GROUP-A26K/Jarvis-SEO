/**
 * lib/circuit.js
 * Circuit breaker par service externe (claude, semrush, flux, sanity, gemini).
 *
 * Apres N echecs consecutifs, le breaker s'ouvre et bloque les appels
 * pendant un cooldown. Cela evite de spammer un service en panne et de
 * gaspiller du budget.
 *
 * L'etat _circuitState vit au niveau du module : une seule instance
 * partagee dans tout le process grace au cache de modules Node.
 *
 * Depend de logger.js pour signaler les ouvertures de circuit.
 */

const { logger } = require('./logger');

const _circuitState = {};

function createCircuitBreaker(serviceName, opts) {
  const threshold = (opts && opts.threshold) || 5;
  const cooldownMs = (opts && opts.cooldownMs) || 60000;

  if (!_circuitState[serviceName]) {
    _circuitState[serviceName] = {
      failures: 0,
      lastFailure: 0,
      state: 'closed', // closed=normal, open=blocked, half-open=testing
    };
  }

  return {
    get state() {
      return _circuitState[serviceName].state;
    },

    /** Verifie si le circuit autorise un appel */
    canExecute() {
      const s = _circuitState[serviceName];
      if (s.state === 'closed') return true;
      if (s.state === 'open') {
        // Check if cooldown has elapsed
        if (Date.now() - s.lastFailure > cooldownMs) {
          s.state = 'half-open';
          return true;
        }
        return false;
      }
      // half-open: allow one test call
      return true;
    },

    /** Signale un succes — reset le compteur */
    recordSuccess() {
      const s = _circuitState[serviceName];
      s.failures = 0;
      s.state = 'closed';
    },

    /** Signale un echec — incremente et ouvre si seuil atteint */
    recordFailure() {
      const s = _circuitState[serviceName];
      s.failures++;
      s.lastFailure = Date.now();
      if (s.failures >= threshold) {
        s.state = 'open';
        logger.warn(
          `Circuit breaker OUVERT: ${serviceName} (${s.failures} echecs consecutifs). Cooldown ${cooldownMs / 1000}s`,
        );
      }
    },

    /** Reset force */
    reset() {
      _circuitState[serviceName] = { failures: 0, lastFailure: 0, state: 'closed' };
    },
  };
}

// Pre-create breakers for external services
const circuitBreakers = {
  claude: createCircuitBreaker('claude', { threshold: 5, cooldownMs: 60000 }),
  semrush: createCircuitBreaker('semrush', { threshold: 5, cooldownMs: 120000 }),
  flux: createCircuitBreaker('flux', { threshold: 3, cooldownMs: 60000 }),
  sanity: createCircuitBreaker('sanity', { threshold: 3, cooldownMs: 60000 }),
  gemini: createCircuitBreaker('gemini', { threshold: 3, cooldownMs: 60000 }),
};

module.exports = {
  createCircuitBreaker,
  circuitBreakers,
};
