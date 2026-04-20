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
const sentry = require('./lib/sentry');
sentry.init({ script: 'workflow-daily' });

const {
  logger, requireAnthropicKey, sendEmail,
} = require('./seo-shared');
const {
  handleScheduledPublication, handlePublishDraft, handleGenerateArticle,
} = require('./handlers/task-handlers');
const {
  getClient,
  fetchTodayPublications, fetchPendingTasks,
  markPublished, ackTask, failTask,
  downloadHeroImage, uploadExhibitToStorage, updatePublicationMetadata,
  saveDraftContent, createNotification, fetchSiteAdmins,
} = require('./calendar-connector');
const { publishToSanity, uploadImageToSanity } = require('./seo-publish-article');

const dryRun = process.argv.includes('--dry-run');

// Destinataires des notifications post-publication (env var requise, pas de fallback hardcode)
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);


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
    try {
      const outcome = await handleScheduledPublication(pub, {
        apiKey, dryRun,
        downloadHeroImage, markPublished, updatePublicationMetadata,
      });
      if (outcome === 'published') results.published++;
      else results.failed++;
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
      // ── publish_draft: publish existing draft_content to Sanity ──
      if (task.action === 'publish_draft') {
        await handlePublishDraft(task, {
          dryRun, logPrefix: '     ', trailingNewline: false,
          client: getClient(), ackTask, downloadHeroImage, uploadImageToSanity,
          publishToSanity, fetchSiteAdmins, createNotification,
        });
        results.tasks++;
        continue;
      }

      // ── generate_article / other actions ──
      await handleGenerateArticle(task, {
        apiKey, dryRun,
        logPrefix: '     ', trailingNewline: false,
        uploadExhibitsToStorage: true,
        announceTask: false,
        logPublishedOk: false, logGenericOk: true,
        client: getClient(), ackTask, downloadHeroImage, markPublished,
        updatePublicationMetadata, saveDraftContent, createNotification,
        fetchSiteAdmins, uploadExhibitToStorage,
      });
      results.tasks++;
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

main().catch((err) => sentry.fatal(err));
