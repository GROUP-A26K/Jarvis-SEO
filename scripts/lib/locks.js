/**
 * lib/locks.js
 * Advisory file-locks (.lock files) avec auto-cleanup sur exit/crash.
 *
 * ATTENTION : side-effects au require.
 * Ce module enregistre 5 handlers process.on() au chargement :
 *   - exit                   → cleanupLocks()
 *   - SIGINT (Ctrl+C)        → cleanupLocks() + exit(130)
 *   - SIGTERM                → cleanupLocks() + exit(143)
 *   - unhandledRejection     → log + cleanupLocks() + exit(1)
 *   - uncaughtException      → log + cleanupLocks() + exit(1)
 *
 * Grace au cache de modules Node, _activeLocks est partage entre tous
 * les callers. Ne jamais dupliquer ce module ni re-enregistrer les handlers.
 *
 * Depend de constants.js (TIMEOUTS), logger.js, fs-utils.js.
 */

const fs = require('fs');
const { TIMEOUTS } = require('./constants');
const { logger } = require('./logger');
const { readJSONSafe, writeJSONAtomic } = require('./fs-utils');

const _activeLocks = new Set();

function acquireLock(filePath, timeoutMs) {
  const lockPath = `${filePath}.lock`;
  const timeout = timeoutMs || TIMEOUTS.fileLock;
  const start = Date.now();

  while (fs.existsSync(lockPath)) {
    try {
      const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (lockAge > 30000) {
        logger.warn(`Lock stale supprime: ${lockPath}`, { age_ms: lockAge });
        try { fs.unlinkSync(lockPath); } catch { /* race ok */ }
        break;
      }
    } catch { break; }

    if (Date.now() - start > timeout) {
      throw new Error(`Lock timeout sur ${filePath} (${timeout}ms)`);
    }
    const waitUntil = Date.now() + 50;
    while (Date.now() < waitUntil) { /* spin */ }
  }

  try {
    fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: 'wx' });
  } catch {
    throw new Error(`Lock concurrent sur ${filePath}`);
  }

  _activeLocks.add(lockPath);

  return function release() {
    try { fs.unlinkSync(lockPath); } catch { /* deja supprime */ }
    _activeLocks.delete(lockPath);
  };
}

function withLockedJSON(filePath, defaultVal, mutator) {
  const release = acquireLock(filePath);
  try {
    const data = readJSONSafe(filePath, defaultVal);
    const result = mutator(data);
    writeJSONAtomic(filePath, data);
    return result;
  } finally {
    release();
  }
}

function cleanupLocks() {
  for (const lockPath of _activeLocks) {
    try { fs.unlinkSync(lockPath); } catch { /* ok */ }
  }
  _activeLocks.clear();
}

process.on('exit', cleanupLocks);
process.on('SIGINT', () => { cleanupLocks(); process.exit(130); });
process.on('SIGTERM', () => { cleanupLocks(); process.exit(143); });
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  cleanupLocks();
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack ? err.stack.split('\n').slice(0, 3).join(' ') : '' });
  cleanupLocks();
  process.exit(1);
});

module.exports = {
  acquireLock,
  withLockedJSON,
};
