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
  logger, requireAnthropicKey, sendEmail, esc,
  validateArticleInput, sanitize,
} = require('./seo-shared');
const { runArticle, sendPublicationNotification, handleScheduledPublication, handlePublishDraft } = require('./handlers/task-handlers');
const fs = require('fs');
const {
  getClient,
  fetchTodayPublications, fetchPendingTasks,
  markPublished, ackTask, failTask,
  downloadHeroImage, updatePublicationMetadata,
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
      const p = task.payload || {};
      const site = (p.site || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
      const keyword = sanitize(p.theme || p.title || 'article').replace(/[\n\r]+/g, ' ');
      if (!site) throw new Error('Payload sans site');

      const inputErrors = validateArticleInput({ site, keyword });
      if (inputErrors.length > 0) throw new Error(`Input invalide: ${inputErrors.join(', ')}`);

      // generate_article tasks use --draft-only (store locally, no Sanity publish)
      const isDraftOnly = task.action === 'generate_article';
      const flags = dryRun ? ['--dry-run'] : (isDraftOnly ? ['--draft-only', '--force'] : ['--force']);

      // Hero image: read hero_image_path from the associated publication
      let heroTmpPath = null;
      let taskWebsiteId = null;
      if (task.publication_id) {
        const { data: pubData } = await getClient()
          .from('publications')
          .select('hero_image_path, website_id')
          .eq('id', task.publication_id)
          .single();

        if (pubData?.hero_image_path) {
          try {
            heroTmpPath = await downloadHeroImage(pubData.hero_image_path);
            flags.push('--image-path', heroTmpPath);
            console.log(`     (hero image: ${pubData.hero_image_path})`);
          } catch (imgErr) {
            logger.warn(`Hero image download failed for task ${task.id}: ${imgErr.message} — will use default`);
          }
        }

        taskWebsiteId = pubData?.website_id || null;
      }

      const { stdout, result, outputJsonPath, execError } = runArticle(site, keyword, flags, apiKey, task.id);
      if (execError && !result) { throw execError; }
      if (result && result.status === 'error' && !isDraftOnly) {
        throw new Error(`Pipeline error: ${result.error.code} — ${result.error.message}`);
      }

      if (!dryRun && isDraftOnly) {
        // ── Draft-only path: store JSON locally, notify admins ──
        // PR 0.3 : read draft from JSON result instead of parsing stdout DRAFT_JSON: line
        if (!result || !result.draft) {
          throw new Error(result && result.error ? `Pipeline error: ${result.error.code} — ${result.error.message}` : 'Pipeline result missing draft payload');
        }
        const parsedDraft = result.draft;

        if (task.publication_id) {
          await saveDraftContent(task.publication_id, parsedDraft);
        }

        await ackTask(task.id, { draft: true, title: parsedDraft.title });

        // Notify site admins/super_admins
        if (taskWebsiteId) {
          try {
            const adminIds = await fetchSiteAdmins(taskWebsiteId);
            for (const adminId of adminIds) {
              await createNotification(
                adminId,
                'draft_ready',
                `Brouillon prêt : ${parsedDraft.title || keyword}`,
                `L'article "${parsedDraft.title || keyword}" pour ${site} est prêt à relire.`,
                task.publication_id,
              );
            }
            logger.info(`Notified ${adminIds.length} admin(s) for draft on ${site}`);
          } catch (notifErr) {
            logger.warn(`Admin notification failed: ${notifErr.message}`);
          }
        }

        console.log(`     + DRAFT saved (not published to Sanity)`);
      } else if (!dryRun) {
        // ── Standard path: publish to Sanity ──
        // PR 0.3 : read from JSON result instead of parsing stdout
        const contentUrl = result && result.contentUrl ? result.contentUrl : null;
        await ackTask(task.id, { content_url: contentUrl });
        if (task.publication_id && contentUrl) {
          await markPublished(task.publication_id, contentUrl);
        }

        if (task.publication_id) {
          const metaUpdates = {};
          if (result && result.sanity && result.sanity.documentId) {
            metaUpdates.sanity_doc_id = result.sanity.documentId;
          }
          if (heroTmpPath && result && result.heroImage && result.heroImage.sanityAssetId) {
            metaUpdates.hero_sanity_asset_id = result.heroImage.sanityAssetId;
            metaUpdates.hero_uploaded_at = new Date().toISOString();
          }
          if (Object.keys(metaUpdates).length > 0) {
            await updatePublicationMetadata(task.publication_id, metaUpdates);
          }
        }
        if (!result) {
          logger.warn(`Pipeline result missing for task ${task.id} — pipeline may have crashed before writing JSON`);
        } else if (result.status === 'error') {
          logger.warn(`Pipeline returned error for task ${task.id}: ${result.error && result.error.code} — ${result.error && result.error.message}`);
        }

        await sendPublicationNotification(site, p.title || keyword, p.theme || keyword, contentUrl);
      }
      // PR 0.3 : cleanup result JSON
      try { if (outputJsonPath && fs.existsSync(outputJsonPath)) fs.unlinkSync(outputJsonPath); } catch (_) {}

      // Cleanup
      if (heroTmpPath) {
        try { fs.unlinkSync(heroTmpPath); } catch (_) {}
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

main().catch((err) => sentry.fatal(err));
