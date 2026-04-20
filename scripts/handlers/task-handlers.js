/**
 * scripts/handlers/task-handlers.js
 *
 * Handlers applicatifs partages entre workflow-daily.js et workflow-single-task.js.
 * Voir scripts/handlers/README.md pour les regles de dependance.
 *
 * PR 0.4 — A26K Group / Jarvis One
 */
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const {
  logger, sendEmail, esc, TIMEOUTS, readTaskResult,
} = require('../seo-shared');

const SCRIPTS_DIR = path.resolve(__dirname, '..');

// ─── runArticle ──────────────────────────────────────────────
// PR 0.3 : runArticle returns { stdout, result, outputJsonPath, execError }
// The result is read from a JSON file written by seo-publish-article.js
// instead of parsing stdout. outputJsonPath is returned so caller cleans it up.
function runArticle(site, keyword, extraFlags, apiKey, taskId) {
  const scriptPath = path.join(SCRIPTS_DIR, 'seo-publish-article.js');
  const tmpDir = process.env.RUNNER_TEMP || '/tmp';
  const uniqueId = taskId || crypto.randomBytes(8).toString('hex');
  const outputJsonPath = path.join(tmpDir, `jarvis-result-${uniqueId}.json`);
  const args = [scriptPath, '--site', site, '--keyword', keyword, '--output-json', outputJsonPath];
  if (taskId) { args.push('--task-id', taskId); }
  if (extraFlags) for (const f of extraFlags) args.push(f);
  let stdout = '';
  let execError = null;
  try {
    stdout = execFileSync(process.execPath, args, {
      stdio: 'pipe',
      env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
      timeout: 5 * TIMEOUTS.claude,
    }).toString();
  } catch (e) {
    stdout = (e.stdout || '').toString();
    execError = e;
  }
  const result = readTaskResult(outputJsonPath);
  return { stdout, result, outputJsonPath, execError };
}

// ─── sendPublicationNotification ─────────────────────────────
/**
 * Envoie un email de notification apres publication reussie.
 * @param {string} site - Domaine du site
 * @param {string} title - Titre de l'article
 * @param {string} theme - Theme de l'article
 * @param {string} url - URL publiee
 */
async function sendPublicationNotification(site, title, theme, url) {
  const date = new Date().toLocaleDateString('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' });
  const siteName = site.replace(/\.ch$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const subject = `[${siteName}] Nouvel article publie — ${esc(title || theme)}`;
  const html = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
    <h2 style="color:#1a1a2e;margin-bottom:4px">${esc(siteName)}</h2>
    <p style="color:#3B82F6;margin-top:0;font-size:13px">Nouvel article publie</p>
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
    <table style="font-size:14px;color:#333;line-height:1.6">
      <tr><td style="padding:4px 12px 4px 0;color:#888">Titre</td><td><strong>${esc(title || '(sans titre)')}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">Theme</td><td>${esc(theme || '-')}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">Site</td><td>${esc(site)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">Date</td><td>${date}</td></tr>
      ${url ? `<tr><td style="padding:4px 12px 4px 0;color:#888">URL</td><td><a href="${esc(url)}" style="color:#3B82F6">${esc(url)}</a></td></tr>` : ''}
    </table>
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
    <p style="color:#999;font-size:12px">Jarvis One | A26K Group</p>
  </div>`;

  try {
    await sendEmail(subject, html);
    logger.info(`Notification envoyee pour [${site}] "${title || theme}"`);
  } catch (e) {
    logger.warn(`Notification email failed: ${e.message}`);
  }
}

// ─── Exports ─────────────────────────────────────────────────
module.exports = {
  runArticle,
  sendPublicationNotification,
};
