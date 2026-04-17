/**
 * lib/logger.js
 * Logger structure (debug/info/warn/error).
 *
 * Le niveau de log par defaut est 'info'. Utiliser logger.setLevel('debug')
 * pour activer les logs de debug, ou 'error' pour reduire au minimum.
 *
 * Aucune dependance sur d'autres modules du projet.
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let _logLevel = LOG_LEVELS.info;

const logger = {
  setLevel(level) {
    _logLevel = LOG_LEVELS[level] || LOG_LEVELS.info;
  },

  _format(level, msg, ctx) {
    const ts = new Date().toISOString();
    const icon = { debug: '.', info: '+', warn: '!', error: 'X' }[level] || ' ';
    const ctxStr = ctx ? ` ${JSON.stringify(ctx)}` : '';
    return `  ${icon} ${msg}${ctxStr}`;
  },

  debug(msg, ctx) {
    if (_logLevel <= LOG_LEVELS.debug) console.log(this._format('debug', msg, ctx));
  },
  info(msg, ctx) {
    if (_logLevel <= LOG_LEVELS.info) console.log(this._format('info', msg, ctx));
  },
  warn(msg, ctx) {
    if (_logLevel <= LOG_LEVELS.warn) console.warn(this._format('warn', msg, ctx));
  },
  error(msg, ctx) {
    if (_logLevel <= LOG_LEVELS.error) console.error(this._format('error', msg, ctx));
  },
};

module.exports = { logger };
