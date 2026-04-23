/**
 * lib/fs-utils.js
 * File I/O utilitaires avec ecriture atomique (tmp + rename) et
 * lecture JSON safe (backup en cas de corruption).
 *
 * Depend de logger.js pour signaler les corruptions.
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeFileAtomic(filePath, data) {
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJSONSafe(filePath, defaultVal) {
  if (!fs.existsSync(filePath)) return defaultVal;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    logger.warn(`JSON corrompu: ${filePath}`, { error: e.message });
    try {
      fs.renameSync(filePath, `${filePath}.bak.${Date.now()}`);
    } catch (bErr) {
      logger.warn(`Backup fichier corrompu echoue`, { error: bErr.message });
    }
    return defaultVal;
  }
}

function writeJSONAtomic(filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2) + '\n');
}

module.exports = {
  ensureDir,
  writeFileAtomic,
  readJSONSafe,
  writeJSONAtomic,
};
