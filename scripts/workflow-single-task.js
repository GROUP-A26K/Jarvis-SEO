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
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const {
  logger, requireAnthropicKey, sendEmail, esc, TIMEOUTS,
  validateArticleInput, sanitize,
} = require('./seo-shared');
const {
  getClient,
  ackTask, failTask,
  downloadHeroImage, updatePublicationMetadata,
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

// ─── Shared helpers (same logic as workflow-daily.js) ────────

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
    const output = runArticle(site, keyword, flags, apiKey);
    const stdout = output.toString();

    if (isDraftOnly) {
      // ── Draft-only path: store JSON, notify admins ──
      const draftLine = stdout.split('\n').find((l) => l.startsWith('DRAFT_JSON:'));
      if (!draftLine) throw new Error('DRAFT_JSON line not found in output');

      let parsedDraft;
      try { parsedDraft = JSON.parse(draftLine.slice('DRAFT_JSON:'.length)); }
      catch (parseErr) { throw new Error(`DRAFT_JSON parse failed: ${parseErr.message}`); }

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

      console.log('  + DRAFT saved (not published to Sanity)\n');
    } else {
      // ── Standard path: publish to Sanity ──
      const urlMatch = stdout.match(/https?:\/\/[^\s]+/);

      await ackTask(task.id, { content_url: urlMatch ? urlMatch[0] : null });
      if (task.publication_id && urlMatch) {
        await markPublished(task.publication_id, urlMatch[0]);
      }

      // Tracability: extract sanity doc id + asset id from stdout
      if (task.publication_id) {
        const metaUpdates = {};
        const docIdMatch = stdout.match(/\+ FR: (article-[a-zA-Z0-9-]+)/);
        if (docIdMatch) metaUpdates.sanity_doc_id = docIdMatch[1];

        if (heroTmpPath) {
          const assetMatch = stdout.match(/Image asset: (image-[a-zA-Z0-9-]+)/);
          if (assetMatch) {
            metaUpdates.hero_sanity_asset_id = assetMatch[1];
            metaUpdates.hero_uploaded_at = new Date().toISOString();
          }
        }

        if (Object.keys(metaUpdates).length > 0) {
          await updatePublicationMetadata(task.publication_id, metaUpdates);
        }
      }

      await sendPublicationNotification(site, p.title || keyword, p.theme || keyword, urlMatch ? urlMatch[0] : null);
      console.log('  + OK (published)\n');
    }

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

main().catch((err) => { console.error(`\n! Fatal: ${err.message}`); process.exit(1); });
