#!/usr/bin/env node
/**
 * workflow-single-task.js
 * On-demand entry point — processes a single jarvis_task by ID.
 *
 * Triggered by GitHub Actions workflow_dispatch (jarvis-on-demand.yml).
 * Reuses the same logic as workflow-daily.js sections 1 & 2.
 *
 * Usage: node scripts/workflow-single-task.js --task-id <uuid>
 *
 * Jarvis One — A26K Group
 */
const sentry = require('./lib/sentry');
sentry.init({ script: 'workflow-single-task' });

const path = require('path');
const fs = require('fs');
const {
  logger, requireAnthropicKey, sendEmail, esc,
  validateArticleInput, sanitize,
} = require('./seo-shared');
const { runArticle, sendPublicationNotification, handleRegenerateExhibit } = require('./handlers/task-handlers');
const {
  getClient,
  ackTask, failTask,
  downloadHeroImage, uploadExhibitToStorage, updatePublicationMetadata,
  saveDraftContent, createNotification, fetchSiteAdmins,
  markPublished,
} = require('./calendar-connector');
const { publishToSanity, uploadImageToSanity } = require('./seo-publish-article');

const SCRIPTS_DIR = __dirname;

// ─── Parse --task-id from CLI args ───────────────────────────

function parseTaskId() {
  const idx = process.argv.indexOf('--task-id');
  if (idx === -1 || !process.argv[idx + 1]) {
    console.error('Usage: node scripts/workflow-single-task.js --task-id <uuid>');
    process.exit(1);
  }
  const taskId = process.argv[idx + 1];
  // Basic UUID validation
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
    console.error(`Invalid task ID format: ${taskId}`);
    process.exit(1);
  }
  return taskId;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const taskId = parseTaskId();

  console.log('========================================');
  console.log('  Jarvis Calendar — On-Demand Task');
  console.log(`  Task: ${taskId}`);
  console.log(`  ${new Date().toISOString().slice(0, 10)}`);
  console.log('========================================\n');

  const apiKey = requireAnthropicKey();

  // ── Fetch the task ──
  const { data: task, error: fetchErr } = await getClient()
    .from('jarvis_tasks')
    .select('id, action, publication_id, payload, status')
    .eq('id', taskId)
    .single();

  if (fetchErr) {
    console.error(`Failed to fetch task: ${fetchErr.message}`);
    process.exit(1);
  }
  if (!task) {
    console.error(`Task not found: ${taskId}`);
    process.exit(1);
  }

  // ── Claim the task (pending → processing) ──
  if (task.status === 'pending') {
    const { error: claimErr } = await getClient()
      .from('jarvis_tasks')
      .update({ status: 'processing' })
      .eq('id', taskId)
      .eq('status', 'pending');

    if (claimErr) {
      console.error(`Failed to claim task: ${claimErr.message}`);
      process.exit(1);
    }
    console.log('> Task claimed (pending → processing)\n');
  } else if (task.status === 'processing') {
    console.log('> Task already processing — resuming\n');
  } else {
    console.error(`Task status is "${task.status}" — expected pending or processing`);
    process.exit(1);
  }

  try {
    // ── publish_draft action ──
    if (task.action === 'publish_draft') {
      if (!task.publication_id) throw new Error('publish_draft requires publication_id');

      const { data: pubRow, error: pubErr } = await getClient()
        .from('publications')
        .select('draft_content, hero_image_path, metadata, website_id, websites(domain, sanity_document_type)')
        .eq('id', task.publication_id)
        .single();
      if (pubErr) throw new Error(`Fetch publication: ${pubErr.message}`);
      if (!pubRow?.draft_content) throw new Error('No draft_content on publication');

      const draft = pubRow.draft_content;
      if (!draft.title || !draft.slug || !Array.isArray(draft.sections)) {
        throw new Error('draft_content is malformed: missing title, slug, or sections');
      }
      const site = pubRow.websites?.domain;
      if (!site) throw new Error('Publication has no site domain');

      const article = {
        title: draft.title, slug: draft.slug, summary: draft.summary || draft.metaDescription,
        metaTitle: draft.metaTitle || draft.title, metaDescription: draft.metaDescription || draft.summary,
        sections: draft.sections || [], faq: draft.faq || [],
        citableExtracts: draft.citableExtracts || [], sourceUrls: draft.sourceUrls || [],
      };
      const persona = draft.persona || 'default';
      const disclaimer = draft.disclaimer || '';

      // Hero image: download from Storage, upload to Sanity
      let imageAssetId = null;
      let heroTmpPath = null;
      if (pubRow.hero_image_path) {
        try {
          heroTmpPath = await downloadHeroImage(pubRow.hero_image_path);
          imageAssetId = await uploadImageToSanity(heroTmpPath);
          console.log(`  + Hero image uploaded: ${imageAssetId}`);
        } catch (imgErr) {
          logger.warn(`Hero image upload failed: ${imgErr.message} — default image will be used`);
        }
      }

      // Publish to Sanity
      const geoScore = { total: 0, status: 'unknown' };
      const keyword = draft.title || '';
      const resFR = await publishToSanity(site, article, 'fr', persona, geoScore, disclaimer, imageAssetId, null, [], keyword);
      console.log(`  + Published to Sanity: ${resFR.docId}`);

      // Update publication
      const contentUrl = `https://${site}/${article.slug}`;
      const metaUpdates = { ...(pubRow.metadata || {}), sanity_doc_id: resFR.docId };
      if (imageAssetId) {
        metaUpdates.hero_sanity_asset_id = imageAssetId;
        metaUpdates.hero_uploaded_at = new Date().toISOString();
      }
      await getClient()
        .from('publications')
        .update({ status: 'published', content_url: contentUrl, metadata: metaUpdates, draft_content: null })
        .eq('id', task.publication_id);

      await ackTask(task.id, { content_url: contentUrl, sanity_doc_id: resFR.docId });

      // Notify admins
      try {
        const adminIds = await fetchSiteAdmins(pubRow.website_id);
        for (const adminId of adminIds) {
          await createNotification(adminId, 'article_published', `Article publie : ${article.title}`, `L'article "${article.title}" a ete publie sur ${site}.`, task.publication_id);
        }
      } catch (notifErr) { logger.warn(`Publish notification failed: ${notifErr.message}`); }

      await sendPublicationNotification(site, article.title, '', contentUrl);

      // Cleanup
      if (heroTmpPath) { try { fs.unlinkSync(heroTmpPath); } catch (_) {} }

      console.log('  + OK (published)\n');
      return;
    }

    // ── regenerate_exhibit action ──
    if (task.action === 'regenerate_exhibit') {
      await handleRegenerateExhibit(task, { client: getClient(), ackTask, uploadExhibitToStorage });
      return;
    }

    // ── generate_article / other actions ──
    const p = task.payload || {};
    const site = (p.site || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const keyword = sanitize(p.theme || p.title || 'article').replace(/[\n\r]+/g, ' ');
    if (!site) throw new Error('Payload sans site');

    const inputErrors = validateArticleInput({ site, keyword });
    if (inputErrors.length > 0) throw new Error(`Input invalide: ${inputErrors.join(', ')}`);

    const isDraftOnly = task.action === 'generate_article';
    const flags = isDraftOnly ? ['--draft-only', '--force'] : ['--force'];

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
          console.log(`  (hero image: ${pubData.hero_image_path})`);
        } catch (imgErr) {
          logger.warn(`Hero image download failed for task ${task.id}: ${imgErr.message} — will use default`);
        }
      }

      taskWebsiteId = pubData?.website_id || null;
    }

    console.log(`  -> [${site}] "${keyword}" (${task.action})`);
    const { stdout, result, outputJsonPath, execError } = runArticle(site, keyword, flags, apiKey, task.id);
    if (execError && !result) { throw execError; }
    if (result && result.status === 'error' && !isDraftOnly) {
      throw new Error(`Pipeline error: ${result.error.code} — ${result.error.message}`);
    }

    if (isDraftOnly) {
      // ── Draft-only path: store JSON, notify admins ──
      // PR 0.3 : read draft from JSON result instead of parsing stdout DRAFT_JSON: line
      if (!result || !result.draft) {
        throw new Error(result && result.error ? `Pipeline error: ${result.error.code} — ${result.error.message}` : 'Pipeline result missing draft payload');
      }
      const parsedDraft = result.draft;

      if (task.publication_id) {
        await saveDraftContent(task.publication_id, parsedDraft);
      }

      // Upload exhibit PNGs to Supabase Storage and update draft_content with paths
      if (task.publication_id && parsedDraft.exhibits && parsedDraft.exhibits.length > 0) {
        try {
          const exhibitPaths = [];
          const exhibitsDir = path.join(SCRIPTS_DIR, '..', 'images', 'exhibits');
          for (const ex of parsedDraft.exhibits) {
            const pngFiles = fs.readdirSync(exhibitsDir).filter(f => f.includes(`-${ex.exhibitNumber}`) && f.endsWith('-source.png'));
            if (pngFiles.length > 0) {
              const localPath = path.join(exhibitsDir, pngFiles[0]);
              const storagePath = await uploadExhibitToStorage(task.publication_id, ex.exhibitNumber, localPath);
              exhibitPaths.push({ ...ex, storagePath });
            }
          }
          if (exhibitPaths.length > 0) {
            const updatedDraft = { ...parsedDraft, exhibits: exhibitPaths };
            await saveDraftContent(task.publication_id, updatedDraft);
            console.log(`  + ${exhibitPaths.length} exhibit(s) uploaded to Storage`);
          }
        } catch (exErr) {
          logger.warn(`Exhibit upload to Storage failed: ${exErr.message}`);
        }
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

      console.log('  + DRAFT saved (not published to Sanity)\n');
    } else {
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
      console.log('  + OK (published)\n');
    }

    // PR 0.3 : cleanup result JSON
    try { if (outputJsonPath && fs.existsSync(outputJsonPath)) fs.unlinkSync(outputJsonPath); } catch (_) {}

    // Cleanup
    if (heroTmpPath) {
      try { fs.unlinkSync(heroTmpPath); } catch (_) {}
    }
  } catch (e) {
    logger.error(`Task ${taskId} failed: ${e.message.slice(0, 200)}`);
    await failTask(taskId, e.message.slice(0, 500));
    process.exit(1);
  }
}

main().catch((err) => sentry.fatal(err));
