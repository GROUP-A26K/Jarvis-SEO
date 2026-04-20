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
  requireAnthropicKey, getSiteConfig,
  sanitize, validateArticleInput,
} = require('../seo-shared');

const fs = require('fs');

// (SCRIPTS_DIR defined below, used by runArticle + handleGenerateArticle)
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

// ─── handleRegenerateExhibit ─────────────────────────────────
/**
 * Handle a 'regenerate_exhibit' task: re-runs planExhibits + processExhibit
 * for a single exhibit_number, uploads the new PNG to Supabase Storage,
 * updates draft_content.exhibits on the publication row, and acks the task.
 *
 * Used by: workflow-single-task.js (on-demand only — not invoked by daily cron).
 *
 * @param {object} task - jarvis_tasks row (needs id, publication_id, payload)
 * @param {object} ctx  - { client, ackTask, uploadExhibitToStorage }
 * @throws on any failure (caller catches and calls failTask)
 */
async function handleRegenerateExhibit(task, ctx) {
  if (!task.publication_id) throw new Error('regenerate_exhibit requires publication_id');
  const exhibitNumber = task.payload?.exhibit_number || 1;
  const userPrompt = task.payload?.prompt || '';

  const { data: pubRow, error: pubErr } = await ctx.client
    .from('publications')
    .select('draft_content, website_id, websites(domain)')
    .eq('id', task.publication_id)
    .single();
  if (pubErr) throw new Error(`Fetch publication: ${pubErr.message}`);
  if (!pubRow?.draft_content) throw new Error('No draft_content on publication');

  const draft = pubRow.draft_content;
  const site = pubRow.websites?.domain;
  if (!site) throw new Error('Publication has no site domain');

  const fullText = (draft.sections || []).map(s => `${s.heading}\n${s.content}`).join('\n\n');

  const { planExhibits, processExhibit } = require('../seo-exhibits');
  const apiKey = requireAnthropicKey();
  const siteConf = getSiteConfig(site);

  const keyword = draft.title || '';
  const briefs = await planExhibits(apiKey, fullText, siteConf ? siteConf.siteContext : {}, keyword);
  const brief = briefs.find(b => b.exhibit_number === exhibitNumber) || briefs[0];
  if (!brief) throw new Error('No exhibit brief generated');

  if (userPrompt) {
    brief.data_context = `${brief.data_context}. Instructions supplémentaires: ${userPrompt}`;
  }

  const result = await processExhibit(apiKey, fullText, brief, keyword, site, draft.slug, true);
  if (!result) throw new Error('Exhibit generation failed');

  // Upload to storage
  const storagePath = await ctx.uploadExhibitToStorage(task.publication_id, exhibitNumber, result.pngPath);

  // Update draft_content.exhibits
  const updatedExhibits = (draft.exhibits || []).filter(e => e.exhibitNumber !== exhibitNumber);
  updatedExhibits.push({ altText: result.altText, exhibitNumber, storagePath });
  updatedExhibits.sort((a, b) => a.exhibitNumber - b.exhibitNumber);

  const updatedDraft = { ...draft, exhibits: updatedExhibits };
  await ctx.client.from('publications').update({ draft_content: updatedDraft }).eq('id', task.publication_id);

  await ctx.ackTask(task.id, { exhibit_number: exhibitNumber, storage_path: storagePath });
  console.log(`  + Exhibit ${exhibitNumber} regenerated and uploaded\n`);
}

// ─── handleScheduledPublication ──────────────────────────────
/**
 * Handle a scheduled publication from the daily cron.
 * Runs the SEO pipeline for one publication row, updates Supabase metadata
 * on success, sends a notification email. Pre-check failures log a warning
 * and return 'skipped'; unexpected runtime errors throw (caller catches).
 *
 * Used by: workflow-daily.js (daily cron batch — not invoked by on-demand).
 *
 * @param {object} pub - publications row (needs id, domain, theme, title, hero_image_path)
 * @param {object} ctx - { apiKey, dryRun, downloadHeroImage, markPublished,
 *                         updatePublicationMetadata }
 * @returns {'published'|'skipped'} — caller counts results.published++/failed++ accordingly
 * @throws on unexpected runtime errors (pipeline crash, Supabase failure, etc.)
 */
async function handleScheduledPublication(pub, ctx) {
  const keyword = sanitize(pub.theme || pub.title || 'article').replace(/[\n\r]+/g, ' ');
  const site = pub.domain;
  if (!site) {
    logger.warn(`Publication ${pub.id}: pas de domain, skip`);
    return 'skipped';
  }

  const inputErrors = validateArticleInput({ site, keyword });
  if (inputErrors.length > 0) {
    logger.warn(`Publication ${pub.id}: input invalide: ${inputErrors.join(', ')}`);
    return 'skipped';
  }

  console.log(`  -> [${site}] "${keyword}"`);
  const flags = ctx.dryRun ? ['--dry-run'] : ['--force'];

  // Hero image custom : download from Storage if present
  let heroTmpPath = null;
  if (pub.hero_image_path) {
    try {
      heroTmpPath = await ctx.downloadHeroImage(pub.hero_image_path);
      flags.push('--image-path', heroTmpPath);
      console.log(`     (hero image: ${pub.hero_image_path})`);
    } catch (imgErr) {
      logger.warn(`Hero image download failed for ${pub.id}: ${imgErr.message} — will use default`);
    }
  }

  const { stdout, result, outputJsonPath, execError } = runArticle(site, keyword, flags, ctx.apiKey, `pub-${pub.id}`);
  if (execError && !result) { throw execError; }
  if (result && result.status === 'error') {
    throw new Error(`Pipeline error: ${result.error.code} — ${result.error.message}`);
  }
  if (!ctx.dryRun) {
    // PR 0.3 : read from JSON result instead of parsing stdout
    const contentUrl = result && result.contentUrl ? result.contentUrl : null;
    await ctx.markPublished(pub.id, contentUrl);

    const metaUpdates = {};
    if (result && result.sanity && result.sanity.documentId) {
      metaUpdates.sanity_doc_id = result.sanity.documentId;
    }
    if (heroTmpPath && result && result.heroImage && result.heroImage.sanityAssetId) {
      metaUpdates.hero_sanity_asset_id = result.heroImage.sanityAssetId;
      metaUpdates.hero_uploaded_at = new Date().toISOString();
    }
    if (!result) {
      logger.warn(`Pipeline result missing for pub ${pub.id} — pipeline may have crashed before writing JSON`);
    } else if (result.status === 'error') {
      logger.warn(`Pipeline returned error for pub ${pub.id}: ${result.error && result.error.code} — ${result.error && result.error.message}`);
    }

    if (Object.keys(metaUpdates).length > 0) {
      await ctx.updatePublicationMetadata(pub.id, metaUpdates);
    }

    await sendPublicationNotification(site, pub.title, pub.theme, contentUrl);
  }
  // PR 0.3 : cleanup result JSON
  try { if (outputJsonPath && fs.existsSync(outputJsonPath)) fs.unlinkSync(outputJsonPath); } catch (_) {}

  // Cleanup temp file
  if (heroTmpPath) {
    try { fs.unlinkSync(heroTmpPath); } catch (_) {}
  }

  console.log(`     + OK`);
  return 'published';
}

// ─── handlePublishDraft ──────────────────────────────────────
/**
 * Publish an existing draft_content row to Sanity (action: 'publish_draft').
 * Called by both workflows: daily batch (with dryRun possible) and single-task.
 *
 * Behavior:
 * - dryRun: log skip, return 'published' (treated as a simulated success).
 * - Otherwise: fetch publication, validate draft_content, upload optional hero
 *   image to Sanity, publish via publishToSanity, update publications row,
 *   ack task, notify admins, send email. Returns 'published'.
 * - Throws on any unexpected error (caller catches and increments failed).
 *
 * @param {object} task - jarvis_tasks row (needs id, publication_id, action)
 * @param {object} ctx - {
 *     dryRun: boolean,           // if true, log skip and return 'published' immediately
 *     logPrefix: string,         // log indent (e.g. '     ' for daily, '  ' for single)
 *     trailingNewline: boolean,  // true for single-task style "+ OK (published)\n"
 *     client, ackTask, downloadHeroImage, uploadImageToSanity, publishToSanity,
 *     fetchSiteAdmins, createNotification,
 *   }
 * @returns {'published'} — caller increments results.tasks or returns normally
 * @throws on unexpected runtime errors
 */
async function handlePublishDraft(task, ctx) {
  const prefix = ctx.logPrefix || '  ';
  const tail = ctx.trailingNewline ? '\n' : '';

  if (!task.publication_id) throw new Error('publish_draft requires publication_id');
  if (ctx.dryRun) {
    console.log(`${prefix}[DRY-RUN] skip publish_draft`);
    return 'published';
  }

  const { data: pubRow, error: pubErr } = await ctx.client
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

  // Build article object from draft
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
      heroTmpPath = await ctx.downloadHeroImage(pubRow.hero_image_path);
      imageAssetId = await ctx.uploadImageToSanity(heroTmpPath);
      console.log(`${prefix}+ Hero image uploaded: ${imageAssetId}`);
    } catch (imgErr) {
      logger.warn(`Hero image upload failed: ${imgErr.message} — default image will be used`);
    }
  }

  // Publish to Sanity
  const geoScore = { total: 0, status: 'unknown' };
  const keyword = draft.title || '';
  const resFR = await ctx.publishToSanity(site, article, 'fr', persona, geoScore, disclaimer, imageAssetId, null, [], keyword);
  console.log(`${prefix}+ Published to Sanity: ${resFR.docId}`);

  // Update publication
  const contentUrl = `https://${site}/${article.slug}`;
  const metaUpdates = { ...(pubRow.metadata || {}), sanity_doc_id: resFR.docId };
  if (imageAssetId) {
    metaUpdates.hero_sanity_asset_id = imageAssetId;
    metaUpdates.hero_uploaded_at = new Date().toISOString();
  }
  await ctx.client
    .from('publications')
    .update({ status: 'published', content_url: contentUrl, metadata: metaUpdates, draft_content: null })
    .eq('id', task.publication_id);

  await ctx.ackTask(task.id, { content_url: contentUrl, sanity_doc_id: resFR.docId });

  // Notify admins
  try {
    const adminIds = await ctx.fetchSiteAdmins(pubRow.website_id);
    for (const adminId of adminIds) {
      await ctx.createNotification(adminId, 'article_published', `Article publie : ${article.title}`, `L'article "${article.title}" a ete publie sur ${site}.`, task.publication_id);
    }
  } catch (notifErr) { logger.warn(`Publish notification failed: ${notifErr.message}`); }

  await sendPublicationNotification(site, article.title, '', contentUrl);

  // Cleanup
  if (heroTmpPath) { try { fs.unlinkSync(heroTmpPath); } catch (_) {} }

  console.log(`${prefix}+ OK (published)${tail}`);
  return 'published';
}

// ─── handleGenerateArticle ───────────────────────────────────
/**
 * Handle a generate_article / other-action task that runs the full SEO
 * pipeline. Supports two modes:
 *   - draft-only (task.action === 'generate_article'): pipeline runs with
 *     --draft-only, result.draft is saved to Supabase, admins notified.
 *   - publish (other actions): pipeline publishes to Sanity; metadata
 *     updated on publications row; notification email sent.
 *
 * Called by both workflow-daily.js (cron task loop) and
 * workflow-single-task.js (on-demand dispatcher).
 *
 * Divergences between the two call-sites are modeled via ctx:
 *   - dryRun: daily may be in dry-run (skip side-effects); single never
 *   - logPrefix, trailingNewline: log formatting
 *   - uploadExhibitsToStorage: present in single-task draft path only;
 *     absent in daily to preserve existing behavior. Known divergence
 *     tracked as a pre-existing quirk (to be addressed in a future PR).
 *
 * @param {object} task - jarvis_tasks row
 * @param {object} ctx - {
 *     apiKey, dryRun, logPrefix, trailingNewline, uploadExhibitsToStorage,
 *     announceTask: boolean,       // single-task logs "-> [site] kw (action)"
 *     client, ackTask, downloadHeroImage, markPublished,
 *     updatePublicationMetadata, saveDraftContent, createNotification,
 *     fetchSiteAdmins, uploadExhibitToStorage,
 *   }
 * @returns {'tasks'|'failed'} — daily uses to increment results.tasks/failed;
 *          single-task ignores the return value (catch-englobing handles
 *          failures). Non-throwing path only returns 'tasks'.
 * @throws on unexpected runtime errors
 */
async function handleGenerateArticle(task, ctx) {
  const prefix = ctx.logPrefix || '  ';
  const tail = ctx.trailingNewline ? '\n' : '';

  const p = task.payload || {};
  const site = (p.site || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const keyword = sanitize(p.theme || p.title || 'article').replace(/[\n\r]+/g, ' ');
  if (!site) throw new Error('Payload sans site');

  const inputErrors = validateArticleInput({ site, keyword });
  if (inputErrors.length > 0) throw new Error(`Input invalide: ${inputErrors.join(', ')}`);

  // generate_article tasks use --draft-only (store locally, no Sanity publish)
  const isDraftOnly = task.action === 'generate_article';
  const flags = ctx.dryRun
    ? ['--dry-run']
    : (isDraftOnly ? ['--draft-only', '--force'] : ['--force']);

  // Hero image: read hero_image_path from the associated publication
  let heroTmpPath = null;
  let taskWebsiteId = null;
  if (task.publication_id) {
    const { data: pubData } = await ctx.client
      .from('publications')
      .select('hero_image_path, website_id')
      .eq('id', task.publication_id)
      .single();

    if (pubData?.hero_image_path) {
      try {
        heroTmpPath = await ctx.downloadHeroImage(pubData.hero_image_path);
        flags.push('--image-path', heroTmpPath);
        console.log(`${prefix}(hero image: ${pubData.hero_image_path})`);
      } catch (imgErr) {
        logger.warn(`Hero image download failed for task ${task.id}: ${imgErr.message} — will use default`);
      }
    }

    taskWebsiteId = pubData?.website_id || null;
  }

  if (ctx.announceTask) {
    console.log(`${prefix}-> [${site}] "${keyword}" (${task.action})`);
  }

  const { stdout, result, outputJsonPath, execError } = runArticle(site, keyword, flags, ctx.apiKey, task.id);
  if (execError && !result) { throw execError; }
  if (result && result.status === 'error' && !isDraftOnly) {
    throw new Error(`Pipeline error: ${result.error.code} — ${result.error.message}`);
  }

  if (!ctx.dryRun && isDraftOnly) {
    // ── Draft-only path: store JSON locally, notify admins ──
    // PR 0.3 : read draft from JSON result instead of parsing stdout DRAFT_JSON: line
    if (!result || !result.draft) {
      throw new Error(result && result.error ? `Pipeline error: ${result.error.code} — ${result.error.message}` : 'Pipeline result missing draft payload');
    }
    const parsedDraft = result.draft;

    if (task.publication_id) {
      await ctx.saveDraftContent(task.publication_id, parsedDraft);
    }

    // Upload exhibit PNGs to Supabase Storage and update draft_content with paths.
    // NOTE: this branch runs only when ctx.uploadExhibitsToStorage is true —
    // currently used by workflow-single-task.js only. workflow-daily.js does
    // not enable it; preserving the pre-PR-0.4 divergence.
    if (ctx.uploadExhibitsToStorage && task.publication_id && parsedDraft.exhibits && parsedDraft.exhibits.length > 0) {
      try {
        const exhibitPaths = [];
        const exhibitsDir = path.join(SCRIPTS_DIR, '..', 'images', 'exhibits');
        for (const ex of parsedDraft.exhibits) {
          const pngFiles = fs.readdirSync(exhibitsDir).filter(f => f.includes(`-${ex.exhibitNumber}`) && f.endsWith('-source.png'));
          if (pngFiles.length > 0) {
            const localPath = path.join(exhibitsDir, pngFiles[0]);
            const storagePath = await ctx.uploadExhibitToStorage(task.publication_id, ex.exhibitNumber, localPath);
            exhibitPaths.push({ ...ex, storagePath });
          }
        }
        if (exhibitPaths.length > 0) {
          const updatedDraft = { ...parsedDraft, exhibits: exhibitPaths };
          await ctx.saveDraftContent(task.publication_id, updatedDraft);
          console.log(`${prefix}+ ${exhibitPaths.length} exhibit(s) uploaded to Storage`);
        }
      } catch (exErr) {
        logger.warn(`Exhibit upload to Storage failed: ${exErr.message}`);
      }
    }

    await ctx.ackTask(task.id, { draft: true, title: parsedDraft.title });

    // Notify site admins/super_admins
    if (taskWebsiteId) {
      try {
        const adminIds = await ctx.fetchSiteAdmins(taskWebsiteId);
        for (const adminId of adminIds) {
          await ctx.createNotification(
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

    console.log(`${prefix}+ DRAFT saved (not published to Sanity)${tail}`);
  } else if (!ctx.dryRun) {
    // ── Standard path: publish to Sanity ──
    // PR 0.3 : read from JSON result instead of parsing stdout
    const contentUrl = result && result.contentUrl ? result.contentUrl : null;
    await ctx.ackTask(task.id, { content_url: contentUrl });
    if (task.publication_id && contentUrl) {
      await ctx.markPublished(task.publication_id, contentUrl);
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
        await ctx.updatePublicationMetadata(task.publication_id, metaUpdates);
      }
    }
    if (!result) {
      logger.warn(`Pipeline result missing for task ${task.id} — pipeline may have crashed before writing JSON`);
    } else if (result.status === 'error') {
      logger.warn(`Pipeline returned error for task ${task.id}: ${result.error && result.error.code} — ${result.error && result.error.message}`);
    }

    await sendPublicationNotification(site, p.title || keyword, p.theme || keyword, contentUrl);
    if (ctx.logPublishedOk) console.log(`${prefix}+ OK (published)${tail}`);
  }
  // PR 0.3 : cleanup result JSON
  try { if (outputJsonPath && fs.existsSync(outputJsonPath)) fs.unlinkSync(outputJsonPath); } catch (_) {}

  // Cleanup
  if (heroTmpPath) {
    try { fs.unlinkSync(heroTmpPath); } catch (_) {}
  }

  if (ctx.logGenericOk) console.log(`${prefix}+ OK`);
  return 'tasks';
}

// ─── Exports ─────────────────────────────────────────────────
module.exports = {
  runArticle,
  sendPublicationNotification,
  handleRegenerateExhibit,
  handleScheduledPublication,
  handlePublishDraft,
  handleGenerateArticle,
};
