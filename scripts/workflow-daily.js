#!/usr/bin/env node
/**
 * workflow-daily.js
 * Daily cron entry point — bridges Jarvis Calendar with the SEO pipeline.
 *
 * 1. Fetches today's scheduled publications from Supabase
 * 2. For each, runs seo-publish-article.js (via runScript2 pattern)
 * 3. Marks publications as published
 * 4. Processes pending jarvis_tasks (e.g. "generate_article" button)
 * 5. Sends recap email
 *
 * Usage: node scripts/workflow-daily.js [--dry-run]
 *
 * Jarvis One — A26K Group
 */
const path = require('path');
const { execFileSync } = require('child_process');
const {
  logger, requireAnthropicKey, sendEmail, esc, TIMEOUTS,
  validateArticleInput, sanitize,
} = require('./seo-shared');
const {
  fetchTodayPublications, fetchPendingTasks,
  markPublished, ackTask, failTask,
} = require('./calendar-connector');

const SCRIPTS_DIR = __dirname;
const dryRun = process.argv.includes('--dry-run');

function runArticle(site, keyword, extraFlags, apiKey) {
  const scriptPath = path.join(SCRIPTS_DIR, 'seo-publish-article.js');
  const args = [scriptPath, '--site', site, '--keyword', keyword];
  if (extraFlags) for (const f of extraFlags) args.push(f);
  return execFileSync(process.execPath, args, {
    stdio: 'pipe',
    env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
    timeout: 5 * TIMEOUTS.claude,
  });
}

async function main() {
  console.log('========================================');
  console.log('  Jarvis Calendar — Daily Workflow');
  console.log(`  ${new Date().toISOString().slice(0, 10)}${dryRun ? ' [DRY-RUN]' : ''}`);
  console.log('========================================\n');

  const apiKey = requireAnthropicKey();
  const results = { published: 0, tasks: 0, failed: 0 };

  // ── 1. Today's scheduled publications ──
  let pubs = [];
  try {
    pubs = await fetchTodayPublications();
  } catch (e) {
    logger.error(`Supabase fetch publications failed: ${e.message}`);
  }
  console.log(`> ${pubs.length} publication(s) programmee(s) aujourd'hui\n`);

  for (const pub of pubs) {
    const keyword = sanitize(pub.theme || pub.title || 'article');
    const site = pub.domain;
    if (!site) { logger.warn(`Publication ${pub.id}: pas de domain, skip`); results.failed++; continue; }

    const inputErrors = validateArticleInput({ site, keyword });
    if (inputErrors.length > 0) {
      logger.warn(`Publication ${pub.id}: input invalide: ${inputErrors.join(', ')}`);
      results.failed++;
      continue;
    }

    console.log(`  -> [${site}] "${keyword}"`);
    try {
      const flags = dryRun ? ['--dry-run'] : ['--force'];
      const output = runArticle(site, keyword, flags, apiKey);
      if (!dryRun) {
        const urlMatch = output.toString().match(/https?:\/\/[^\s]+/);
        await markPublished(pub.id, urlMatch ? urlMatch[0] : null);
      }
      results.published++;
      console.log(`     + OK`);
    } catch (e) {
      logger.error(`Publication ${pub.id} failed: ${e.message.slice(0, 200)}`);
      results.failed++;
    }
  }

  // ── 2. Pending tasks (bouton "Generer avec Jarvis") ──
  let tasks = [];
  try {
    tasks = await fetchPendingTasks();
  } catch (e) {
    logger.error(`Supabase fetch tasks failed: ${e.message}`);
  }
  console.log(`\n> ${tasks.length} tache(s) pending\n`);

  for (const task of tasks) {
    console.log(`  -> Task ${task.id} (${task.action})`);
    try {
      const p = task.payload || {};
      const site = p.site;
      const keyword = sanitize(p.theme || p.title || 'article');
      if (!site) throw new Error('Payload sans site');

      const inputErrors = validateArticleInput({ site, keyword });
      if (inputErrors.length > 0) throw new Error(`Input invalide: ${inputErrors.join(', ')}`);

      const flags = dryRun ? ['--dry-run'] : ['--force'];
      const output = runArticle(site, keyword, flags, apiKey);
      const urlMatch = output.toString().match(/https?:\/\/[^\s]+/);

      if (!dryRun) {
        await ackTask(task.id, { content_url: urlMatch ? urlMatch[0] : null });
        if (task.publication_id && urlMatch) {
          await markPublished(task.publication_id, urlMatch[0]);
        }
      }
      results.tasks++;
      console.log(`     + OK`);
    } catch (e) {
      logger.error(`Task ${task.id} failed: ${e.message.slice(0, 200)}`);
      if (!dryRun) await failTask(task.id, e.message.slice(0, 500));
      results.failed++;
    }
  }

  // ── 3. Recap ──
  console.log('\n========================================');
  console.log(`  Published: ${results.published} | Tasks: ${results.tasks} | Failed: ${results.failed}`);
  console.log('========================================\n');

  if (!dryRun && (results.published > 0 || results.tasks > 0 || results.failed > 0)) {
    try {
      await sendEmail(
        `Jarvis Calendar Daily | ${results.published} pub, ${results.tasks} tasks | ${new Date().toISOString().slice(0, 10)}`,
        `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#1a1a2e">Jarvis Calendar — Recap quotidien</h2>
        <p style="color:#555"><strong>${results.published}</strong> publications | <strong>${results.tasks}</strong> taches | <strong>${results.failed}</strong> echecs</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#999;font-size:12px">Jarvis One | A26K Group</p></div>`
      );
      console.log('+ Email recap envoye');
    } catch (e) { logger.warn(`Email recap: ${e.message}`); }
  }
}

main().catch((err) => { console.error(`\n! Fatal: ${err.message}`); process.exit(1); });
