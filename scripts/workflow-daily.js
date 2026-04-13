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
const fs = require('fs');
const {
  fetchTodayPublications, fetchPendingTasks,
  markPublished, ackTask, failTask,
  downloadHeroImage, updatePublicationMetadata,
} = require('./calendar-connector');

const SCRIPTS_DIR = __dirname;
const dryRun = process.argv.includes('--dry-run');

// Destinataires des notifications post-publication
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || 'jeanbaptiste@a26k.ch,sebastien@a26k.ch,benjamin@a26k.ch').split(',').map(e => e.trim());

/**
 * Envoie un email de notification après publication réussie.
 * @param {string} site - Domaine du site
 * @param {string} title - Titre de l'article
 * @param {string} theme - Thème de l'article
 * @param {string} url - URL publiée
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
    const keyword = sanitize(pub.theme || pub.title || 'article').replace(/[\n\r]+/g, ' ');
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

      // Hero image custom : download from Storage if present
      let heroTmpPath = null;
      if (pub.hero_image_path) {
        try {
          heroTmpPath = await downloadHeroImage(pub.hero_image_path);
          flags.push('--image-path', heroTmpPath);
          console.log(`     (hero image: ${pub.hero_image_path})`);
        } catch (imgErr) {
          logger.warn(`Hero image download failed for ${pub.id}: ${imgErr.message} — will use default`);
        }
      }

      const output = runArticle(site, keyword, flags, apiKey);
      if (!dryRun) {
        const urlMatch = output.toString().match(/https?:\/\/[^\s]+/);
        await markPublished(pub.id, urlMatch ? urlMatch[0] : null);

        // Tracability: extract sanity asset id from stdout if hero custom was used
        if (heroTmpPath) {
          const assetMatch = output.toString().match(/Image asset: (image-[a-zA-Z0-9-]+)/);
          if (assetMatch) {
            await updatePublicationMetadata(pub.id, {
              hero_sanity_asset_id: assetMatch[1],
              hero_uploaded_at: new Date().toISOString(),
            });
          }
        }

        await sendPublicationNotification(site, pub.title, pub.theme, urlMatch ? urlMatch[0] : null);
      }

      // Cleanup temp file
      if (heroTmpPath) {
        try { fs.unlinkSync(heroTmpPath); } catch (_) {}
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
      const keyword = sanitize(p.theme || p.title || 'article').replace(/[\n\r]+/g, ' ');
      if (!site) throw new Error('Payload sans site');

      const inputErrors = validateArticleInput({ site, keyword });
      if (inputErrors.length > 0) throw new Error(`Input invalide: ${inputErrors.join(', ')}`);

      const flags = dryRun ? ['--dry-run'] : ['--force'];

      // Hero image: read hero_image_path from the associated publication
      let heroTmpPath = null;
      if (task.publication_id) {
        const { data: pubData } = await require('./calendar-connector').getClient()
          .from('publications')
          .select('hero_image_path')
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
      }

      const output = runArticle(site, keyword, flags, apiKey);
      const urlMatch = output.toString().match(/https?:\/\/[^\s]+/);

      if (!dryRun) {
        await ackTask(task.id, { content_url: urlMatch ? urlMatch[0] : null });
        if (task.publication_id && urlMatch) {
          await markPublished(task.publication_id, urlMatch[0]);
        }

        // Tracability: hero image
        if (heroTmpPath && task.publication_id) {
          const assetMatch = output.toString().match(/Image asset: (image-[a-zA-Z0-9-]+)/);
          if (assetMatch) {
            await updatePublicationMetadata(task.publication_id, {
              hero_sanity_asset_id: assetMatch[1],
              hero_uploaded_at: new Date().toISOString(),
            });
          }
        }

        await sendPublicationNotification(site, p.title || keyword, p.theme || keyword, urlMatch ? urlMatch[0] : null);
      }

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

main().catch((err) => { console.error(`\n! Fatal: ${err.message}`); process.exit(1); });
