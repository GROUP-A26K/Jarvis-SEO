#!/usr/bin/env node
/**
 * seo-orchestrator.js v1
 * Orchestrateur du workflow SEO.
 *
 * Phases:
 *   --plan     : analyse gaps + tracking, appel Claude Strategist, produit plan + briefs DA, email
 *   --execute  : lit le plan approuve, lance dry-runs, attend images, review consolidé
 *   --publish  : publie les articles approuves dans Sanity
 *   --status   : affiche l'etat du pipeline courant
 *
 * Workflow:
 *   [Lundi 6h]    node seo-gap-analysis.js
 *   [Lundi 6h30]  node seo-orchestrator.js --plan
 *   [Humain]      Review plan -> plan-approved-YYYY-WNN.json
 *   [Apres review] node seo-orchestrator.js --execute
 *   [Humain]      Review articles + images -> approuve dans pipeline-state
 *   [Final]       node seo-orchestrator.js --publish
 *
 * Jarvis One — Groupe Genevoise
 */
const sentry = require('./lib/sentry');
sentry.init({ script: 'seo-orchestrator' });

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  PATHS, logger, validateEnv, ensureDir, requireAnthropicKey,
  loadSecret, getSiteConfig, getSiteList, getSiteLabels,
  callClaudeWithRetry, extractClaudeText, printUnitsSummary, loadUnitsState,
  loadTrackedArticles, loadLatestGapAnalysis, loadPipelineState, savePipelineState,
  sanitize, sanitizeFilename, esc, httpRequest, sendEmail,
  validateArticleInput, getISOWeek, writeJSONAtomic, readJSONSafe,
  VALID_PERSONAS, EMAIL_RECIPIENTS, MAX_ARTICLES_PER_WEEK, TIMEOUTS,
} = require('./seo-shared');

// ─── Config ──────────────────────────────────────────────────

const SCRIPTS_DIR = PATHS.scripts;
const SITE_LABELS = getSiteLabels();

// Execute script 2 safely (no shell, no injection)
function runScript2(art, extraFlags, apiKey) {
  const scriptPath = path.join(SCRIPTS_DIR, 'seo-publish-article.js');
  const args = [scriptPath, '--site', art.site, '--keyword', art.keyword];
  if (art.persona) args.push('--persona', art.persona);
  if (extraFlags) for (const f of extraFlags) args.push(f);
  return execFileSync(process.execPath, args, {
    stdio: 'pipe', env: { ...process.env, ANTHROPIC_API_KEY: apiKey }, timeout: 5 * TIMEOUTS.claude,
  });
}

// ─── Data Loaders ────────────────────────────────────────────
// All loaded from seo-shared.js: loadLatestGapAnalysis, loadTrackedArticles,
// loadPipelineState, savePipelineState, validateArticleInput

// ─── Email & HTTP ───────────────────────────────────────────
// Loaded from seo-shared.js: httpRequest, sendEmail

// ─── PHASE 1: PLAN ──────────────────────────────────────────

async function phasePlan() {
  console.log('========================================');
  console.log('  Orchestrateur — PLAN');
  console.log('========================================');

  const apiKey = requireAnthropicKey();
  const weekStr = getISOWeek();
  const forceFlag = process.argv.includes('--force');

  // Guard: don't overwrite a pipeline with progress
  const existing = loadPipelineState();
  if (existing && existing.phase !== 'published' && !forceFlag) {
    const inProgress = (existing.articles || []).filter((a) => a.status !== 'planned');
    if (inProgress.length > 0) {
      console.error(`\n  ! Pipeline "${existing.id}" en cours (${inProgress.length} articles avances).`);
      console.error('  Utiliser --plan --force pour ecraser, ou --publish pour terminer.');
      process.exit(1);
    }
  }

  // 1. Charger les donnees
  console.log('\n> Chargement des donnees...');

  const gap = loadLatestGapAnalysis();
  if (!gap) throw new Error('Aucun gap analysis trouve. Lancer seo-gap-analysis.js d\'abord.');
  console.log(`  + Gap analysis: ${gap.date} (${Object.keys(gap.sites).length} sites)`);

  const tracked = loadTrackedArticles();
  console.log(`  + ${tracked.length} articles trackes`);

  const units = loadUnitsState();
  console.log(`  + Semrush units: ${units.consumed}/${units.planTotal} (${Math.round(units.consumed / units.planTotal * 100)}%)`);

  // Construire un resume des articles existants par site
  const existingBySite = {};
  for (const site of getSiteList()) existingBySite[site] = [];
  for (const art of tracked) {
    if (art.site && existingBySite[art.site]) {
      existingBySite[art.site].push({
        keyword: art.keyword, slug: art.slug,
        geoScore: art.geo_score, position: art.position_j30 || art.position_j60 || art.position_j90 || null,
        publishedAt: art.published_at || art.publishedAt,
      });
    }
  }

  // Construire le contexte pour Claude Strategist
  const gapSummary = {};
  for (const [site, data] of Object.entries(gap.sites)) {
    gapSummary[site] = {
      verticale: data.verticale,
      topGaps: (data.keywordGap || []).slice(0, 10).map((g) => ({
        keyword: g.keyword, volume: g.volume, difficulty: g.difficulty,
        score: g.score, intent: g.intent,
        trending: g.trend ? g.trend.trending : false,
        trendRatio: g.trend ? g.trend.trendRatio : 1,
        featuredSnippet: g.featuredSnippet || false,
      })),
      clusters: (data.clusters || []).slice(0, 3),
      featuredSnippets: data.featuredSnippets || { gaps: [], capturable: [] },
      existingArticles: existingBySite[site] || [],
    };
  }

  // Decay articles (pour content refresh)
  const decayArticles = tracked.filter((a) => {
    if (!a.published_at && !a.publishedAt) return false;
    const pubDate = new Date(a.published_at || a.publishedAt);
    if (isNaN(pubDate.getTime())) return false;
    const monthsOld = (Date.now() - pubDate.getTime()) / (30 * 24 * 3600 * 1000);
    if (monthsOld < 6) return false;
    const best = Math.min(a.position_j30 || 999, a.position_j60 || 999, a.position_j90 || 999);
    return best < 999;
  }).map((a) => ({ keyword: a.keyword, site: a.site, slug: a.slug, bestPosition: Math.min(a.position_j30 || 999, a.position_j60 || 999, a.position_j90 || 999), monthsOld: Math.round((Date.now() - new Date(a.published_at || a.publishedAt).getTime()) / (30 * 24 * 3600 * 1000)) }));

  // 2. Appel Claude Strategist
  console.log('\n> Appel Claude Strategist...');

  const strategistPrompt = `Tu es le strategiste SEO du Groupe Genevoise (5 sites suisses).

CONTEXTE:
- Semaine: ${weekStr}
- Budget Semrush: ${units.consumed}/${units.planTotal} units utilisees
- Max articles cette semaine: ${MAX_ARTICLES_PER_WEEK}

DONNEES PAR SITE:
${JSON.stringify(gapSummary, null, 2)}

ARTICLES EN DECAY (candidates content refresh):
${decayArticles.length > 0 ? JSON.stringify(decayArticles, null, 2) : 'Aucun'}

INSTRUCTIONS:
Selectionne les ${MAX_ARTICLES_PER_WEEK} meilleurs articles a publier cette semaine.
Pour chaque article, explique POURQUOI tu le selectionnes (pas juste le score).
Considere: diversification des sites, clusters thematiques, trending keywords, featured snippets capturables, content refresh necessaire.

Reponds UNIQUEMENT en JSON:
{
  "weekStr": "${weekStr}",
  "reasoning": "Strategie globale en 2-3 phrases",
  "articles": [
    {
      "priority": 1,
      "site": "medcourtage.ch",
      "keyword": "rc pro medecin geneve",
      "type": "new|refresh",
      "persona": "Hugo Schaller",
      "format": "guide|comparatif|checklist|faq|etude-de-cas",
      "reasoning": "Pourquoi cet article maintenant"
    }
  ]
}`;

  const resp = await callClaudeWithRetry(apiKey, 'Strategiste SEO. Reponds UNIQUEMENT en JSON valide.', strategistPrompt, 4096);
  const cleaned = extractClaudeText(resp).replace(/```json\s?|```/g, '').trim();
  let plan;
  try { plan = JSON.parse(cleaned); } catch (e) { throw new Error(`Plan JSON invalide: ${cleaned.slice(0, 300)}. ${e.message}`); }

  if (!plan.articles || !Array.isArray(plan.articles)) throw new Error('Plan sans articles');

  // Valider les sites et personas
  plan.articles = plan.articles.filter((a) => {
    if (!getSiteList().includes(a.site)) { logger.warn(`Site invalide "${a.site}", article ignore`); return false; }
    if (!a.keyword) { logger.warn('Article sans keyword, ignore'); return false; }
    return true;
  });

  console.log(`\n+ Plan: ${plan.articles.length} articles`);
  console.log(`  Strategie: ${plan.reasoning || 'N/A'}`);
  for (const art of plan.articles) {
    console.log(`  ${art.priority}. [${SITE_LABELS[art.site] || art.site}] "${art.keyword}" (${art.type || 'new'}, ${art.format || 'guide'})`);
    console.log(`     -> ${art.reasoning || 'N/A'}`);
  }

  // 3. Sauvegarder le plan
  const planId = `plan-${weekStr}`;
  const state = {
    id: planId, weekStr, phase: 'plan_sent', createdAt: new Date().toISOString(),
    reasoning: plan.reasoning, articles: plan.articles.map((a, i) => ({
      ...a, index: i, status: 'planned',
      dryRunPath: null, imagePlanPath: null, articleSlug: null,
      imagesReady: false, imagesResult: null, imagesPath: null,
      approved: null, publishedDocId: null,
    })),
  };

  savePipelineState(state);
  console.log(`\n+ Pipeline state: ${PATHS.pipelineState}`);

  // Sauvegarder aussi en fichier plan separé pour le review
  const planPath = path.join(PATHS.reports, `${planId}.json`);
  ensureDir(PATHS.reports);
  writeJSONAtomic(planPath, state);
  console.log(`+ Plan: ${planPath}`);

  // 4. Envoyer email
  console.log('\n> Envoi email...');
  const wn = weekStr.split('W')[1];
  const emailHtml = buildPlanEmail(state, wn);
  try {
    await sendEmail(`Plan SEO S${wn} | ${plan.articles.length} articles | Groupe Genevoise`, emailHtml);
    console.log('  + Email envoye');
  } catch (e) { console.error(`  ! Email: ${e.message}`); }

  printUnitsSummary();
  console.log('\n========================================');
  console.log(`+ PLAN envoye. Approuver dans: ${planPath}`);
  console.log('  Puis lancer: node seo-orchestrator.js --execute');
  console.log('========================================\n');
}

function buildPlanEmail(state, wn) {
  const rows = state.articles.map((a) => `<tr>
    <td><strong>${a.priority}</strong></td>
    <td>${esc(SITE_LABELS[a.site] || a.site)}</td>
    <td><strong>${esc(a.keyword)}</strong></td>
    <td>${esc(a.type || 'new')}</td>
    <td>${esc(a.format || 'guide')}</td>
    <td style="font-size:11px;color:#666">${esc((a.reasoning || '').slice(0, 80))}</td>
  </tr>`).join('');

  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px">
<h2 style="color:#1a1a2e">Plan SEO — Semaine ${esc(wn)}</h2>
<p style="color:#555;font-size:14px"><strong>${state.articles.length}</strong> articles proposes</p>
<p style="color:#555;font-size:13px;margin-bottom:15px"><em>${esc(state.reasoning || '')}</em></p>
<table style="width:100%;border-collapse:collapse;font-size:12px">
<thead><tr style="background:#1a1a2e;color:white"><th style="padding:8px">#</th><th style="padding:8px">Site</th><th style="padding:8px">Keyword</th><th style="padding:8px">Type</th><th style="padding:8px">Format</th><th style="padding:8px">Raison</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p style="margin-top:20px;color:#555;font-size:13px">Pour approuver: modifier le fichier plan JSON (status: "approved") puis lancer <code>node seo-orchestrator.js --execute</code></p>
<hr style="border:none;border-top:1px solid #eee;margin:20px 0">
<p style="color:#999;font-size:12px">Jarvis One | A26K Group</p>
</div>`;
}

// ─── PHASE 2: EXECUTE ────────────────────────────────────────

async function phaseExecute() {
  console.log('========================================');
  console.log('  Orchestrateur — EXECUTE');
  console.log('========================================');

  const state = loadPipelineState();
  if (!state) throw new Error('Aucun pipeline actif. Lancer --plan d\'abord.');

  // Chercher le plan approuve (soit pipeline-state modifie, soit fichier plan-approved)
  const approvedPath = path.join(PATHS.reports, `plan-approved-${state.weekStr}.json`);
  let approvedArticles;

  if (fs.existsSync(approvedPath)) {
    console.log(`  + Plan approuve charge: ${approvedPath}`);
    try {
      const approved = readJSONSafe(approvedPath, null); if (!approved) throw new Error('Plan approuve invalide');
      const approvedFromFile = (approved.articles || []).filter((a) => a.status === 'approved' || a.approved === true);
      // Sync approved articles back into state.articles by keyword+site match
      for (const af of approvedFromFile) {
        const match = state.articles.find((sa) => sa.keyword === af.keyword && sa.site === af.site);
        if (match) {
          match.status = 'approved';
          match.approved = true;
          // Preserve any fields from the approved file that the user may have edited
          if (af.persona) match.persona = af.persona;
          if (af.format) match.format = af.format;
        }
      }
      approvedArticles = state.articles.filter((a) => a.status === 'approved' || a.approved === true);
    } catch (e) {
      console.error(`  ! Erreur lecture plan approuve: ${e.message}`);
      approvedArticles = [];
    }
  } else {
    // Fallback: articles marques approved dans pipeline-state
    approvedArticles = state.articles.filter((a) => a.status === 'approved' || a.approved === true);
  }

  if (approvedArticles.length === 0) {
    console.log('\n  ! Aucun article approuve.');
    console.log(`  Modifier le plan dans ${PATHS.pipelineState} ou creer ${approvedPath}`);
    console.log('  Mettre status: "approved" pour chaque article a publier.');
    return;
  }

  console.log(`\n+ ${approvedArticles.length} articles approuves`);

  const apiKey = requireAnthropicKey();

  for (const art of approvedArticles) {
    console.log(`\n> [${art.priority}] "${art.keyword}" (${art.site})`);

    // Validate inputs before executing
    const inputErrors = validateArticleInput(art);
    if (inputErrors.length > 0) {
      console.error(`  ! Input invalide: ${inputErrors.join(', ')}`);
      art.status = 'input_invalid';
      art.error = inputErrors.join('; ');
      savePipelineState(state);
      continue;
    }

    // a. Dry-run
    if (!art.dryRunPath || !fs.existsSync(art.dryRunPath)) {
      console.log('  -> Dry-run...');
      try {
        runScript2(art, ['--dry-run'], apiKey);

        // Trouver le fichier dry-run genere
        const dryRunFiles = fs.readdirSync(PATHS.reports).filter((f) => f.startsWith(`article-dryrun-${art.site}`) && f.endsWith('.json')).sort().reverse();
        if (dryRunFiles.length > 0) {
          art.dryRunPath = path.join(PATHS.reports, dryRunFiles[0]);
          art.status = 'dry_run_done';
          console.log(`  + Dry-run: ${art.dryRunPath}`);

          // Extraire le score GEO du dry-run
          try {
            const dryRunData = readJSONSafe(art.dryRunPath, null);
            if (dryRunData) art.geoScore = dryRunData.geoScore ? dryRunData.geoScore.total : null;
            art.geoStatus = dryRunData.geoScore ? dryRunData.geoScore.status : null;
          } catch (e) { logger.debug("catch silencieux", { error: e.message }); }
        }
      } catch (e) {
        console.error(`  ! Dry-run echoue: ${e.message}`);
        art.status = 'dry_run_failed';
        art.error = e.message.slice(0, 200);
        continue;
      }
    } else {
      console.log(`  + Dry-run existant: ${art.dryRunPath}`);
    }

    // b. Image plan (contrat d'interface pour le script images)
    //    Le script images (seo-images.js) lit ce plan, exécute Agent 0 → Agent 1 → Flux → Agent 2 → Sharp
    if (art.dryRunPath && fs.existsSync(art.dryRunPath)) {
      ensureDir(PATHS.images);
      try {
        const dryRunData = readJSONSafe(art.dryRunPath, null);
        const slug = dryRunData.articleFR ? dryRunData.articleFR.slug : null;

        if (slug) {
          const siteConfig = getSiteConfig(art.site);
          const planPath = path.join(PATHS.images, `plan-${sanitizeFilename(slug)}.json`);

          // Ne pas regenerer si le plan existe deja (idempotent)
          if (!fs.existsSync(planPath)) {
            writeJSONAtomic(planPath, {
              slug,
              site: art.site,
              persona: art.persona,
              keyword: art.keyword,
              dryRunPath: art.dryRunPath,
              siteContext: siteConfig ? siteConfig.siteContext : { secteur: SITE_LABELS[art.site] || art.site, ton: '', public: '', palette: [], exemples_articles: '' },
              createdAt: new Date().toISOString(),
            });
            console.log(`  + Image plan: ${planPath}`);
          } else {
            console.log(`  + Image plan existant: ${planPath}`);
          }
          art.imagePlanPath = planPath;
          art.articleSlug = slug;
        }
      } catch (e) { logger.warn(`Image plan: ${e.message}`); }
    }

    // c. Verifier si les images sont pretes
    //    1. Lire result-{slug}.json (metadonnees SEO completes du script images)
    //    2. Fallback: detecter les fichiers images par convention de nommage
    if (art.articleSlug) {
      const resultPath = path.join(PATHS.images, `result-${sanitizeFilename(art.articleSlug)}.json`);
      if (fs.existsSync(resultPath)) {
        try {
          const result = readJSONSafe(resultPath, null);
          if (result.status === 'complete' && result.images && result.images.length > 0) {
            art.imagesReady = true;
            art.imagesResult = result;
            art.imagesPath = result.images.map((img) => path.join(PATHS.images, img.filename));
            art.status = 'ready_for_review';
            console.log(`  + Images (result): ${result.images.length} images, cout $${(result.cost && result.cost.total || 0).toFixed(2)}`);
          }
        } catch (e) { logger.debug("catch silencieux", { error: e.message }); }
      } else if (fs.existsSync(PATHS.images)) {
        // Fallback: detection par convention de nommage ({slug}-hero.*)
        const imageFiles = fs.readdirSync(PATHS.images).filter((f) => f.startsWith(art.articleSlug) && !f.endsWith('.json'));
        if (imageFiles.length > 0) {
          art.imagesReady = true;
          art.imagesPath = imageFiles.map((f) => path.join(PATHS.images, f));
          art.status = 'ready_for_review';
          console.log(`  + Images (fichiers): ${imageFiles.join(', ')}`);
        } else {
          console.log(`  ~ Images en attente — lancer: node seo-images.js --plan ${sanitizeFilename(art.articleSlug)}`);
        }
      }
    }

    savePipelineState(state);
  }

  // Resume
  const done = approvedArticles.filter((a) => a.status === 'dry_run_done' || a.status === 'ready_for_review').length;
  const failed = approvedArticles.filter((a) => a.status === 'dry_run_failed').length;
  const withImages = approvedArticles.filter((a) => a.imagesReady).length;

  console.log('\n========================================');
  console.log(`+ EXECUTE termine`);
  console.log(`  Dry-runs: ${done}/${approvedArticles.length} (${failed} echecs)`);
  console.log(`  Images pretes: ${withImages}/${done}`);
  if (withImages < done) {
    console.log(`  -> Deposer les images dans ${PATHS.images}/`);
    console.log('  -> Relancer --execute pour verifier les images');
  }
  console.log('  -> Puis: node seo-orchestrator.js --publish');
  printUnitsSummary();
  console.log('========================================\n');

  // Email resume
  try {
    const wn = state.weekStr.split('W')[1];
    await sendEmail(`Execution SEO S${wn} | ${done} dry-runs | Groupe Genevoise`,
      `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <h2 style="color:#1a1a2e">Execution S${wn}</h2>
      <p style="color:#555"><strong>${done}</strong> dry-runs OK | <strong>${failed}</strong> echecs | <strong>${withImages}</strong> images pretes</p>
      ${approvedArticles.map((a) => `<p style="font-size:13px;color:${a.status === 'dry_run_failed' ? '#e74c3c' : '#27ae60'}">
        ${a.status === 'dry_run_failed' ? '!' : '+'} "${esc(a.keyword)}" (${esc(SITE_LABELS[a.site] || a.site)}) — ${esc(a.status)}${a.geoScore ? ` — GEO: ${a.geoScore}` : ''}</p>`).join('')}
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
      <p style="color:#999;font-size:12px">Jarvis One | A26K Group</p></div>`);
    console.log('  + Email envoye');
  } catch (e) { logger.debug("catch silencieux", { error: e.message }); }
}

// ─── PHASE 3: PUBLISH ────────────────────────────────────────

async function phasePublish() {
  console.log('========================================');
  console.log('  Orchestrateur — PUBLISH');
  console.log('========================================');

  const state = loadPipelineState();
  if (!state) throw new Error('Aucun pipeline actif.');

  const apiKey = requireAnthropicKey();

  // Articles prets pour publication: require explicit approval
  // User can set either approved:true OR status:"approved" in pipeline-state.json
  const toPublish = state.articles.filter((a) =>
    (a.status === 'ready_for_review' || a.status === 'dry_run_done' || a.status === 'approved') &&
    (a.approved === true || a.status === 'approved')
  );

  if (toPublish.length === 0) {
    console.log('\n  ! Aucun article approuve pour publication.');
    console.log('  Mettre "approved": true OU "status": "approved" dans pipeline-state.json.');
    const pendingReview = state.articles.filter((a) => (a.status === 'ready_for_review' || a.status === 'dry_run_done') && a.approved !== true);
    if (pendingReview.length > 0) {
      console.log(`  ${pendingReview.length} articles en attente d'approbation:`);
      pendingReview.forEach((a) => console.log(`    - "${a.keyword}" (${a.site}) [${a.status}]`));
    }
    return;
  }

  console.log(`\n+ ${toPublish.length} articles approuves a publier`);
  let published = 0, failed = 0;

  for (const art of toPublish) {
    console.log(`\n> "${art.keyword}" (${art.site})`);

    // Validate inputs
    const inputErrors = validateArticleInput(art);
    if (inputErrors.length > 0) {
      console.error(`  ! Input invalide: ${inputErrors.join(', ')}`);
      art.status = 'input_invalid';
      failed++;
      savePipelineState(state);
      continue;
    }

    try {
      // Build flags: --force + image path/alt if available from pipeline
      const flags = ['--force'];
      if (art.imagesResult && art.imagesResult.images && art.imagesResult.images.length > 0) {
        const heroImg = art.imagesResult.images.find((img) => img.role === 'hero') || art.imagesResult.images[0];
        const imgPath = path.join(PATHS.images, heroImg.filename);
        if (fs.existsSync(imgPath)) {
          flags.push('--image-path', imgPath);
          if (heroImg.altText) flags.push('--image-alt', heroImg.altText);
          console.log(`  + Image: ${heroImg.filename}`);
        }
      } else if (art.imagesPath && art.imagesPath.length > 0) {
        // Fallback: use first image file detected
        const heroFile = art.imagesPath.find((f) => f.includes('hero')) || art.imagesPath[0];
        if (fs.existsSync(heroFile)) {
          flags.push('--image-path', heroFile);
          console.log(`  + Image (fallback): ${path.basename(heroFile)}`);
        }
      }

      const output = runScript2(art, flags, apiKey);

      art.status = 'published';
      art.publishedAt = new Date().toISOString();
      published++;

      // Extraire le docId du output
      const docMatch = output.toString().match(/FR: (article-[^\s]+)/);
      if (docMatch) art.publishedDocId = docMatch[1];

      console.log(`  + Publie${art.publishedDocId ? `: ${art.publishedDocId}` : ''}`);
    } catch (e) {
      console.error(`  ! Publication echouee: ${e.message.slice(0, 200)}`);
      art.status = 'publish_failed';
      art.error = e.message.slice(0, 200);
      failed++;
    }

    savePipelineState(state);
  }

  state.phase = 'published';
  savePipelineState(state);

  console.log('\n========================================');
  console.log(`+ PUBLISH termine: ${published} publies, ${failed} echecs`);
  printUnitsSummary();
  console.log('========================================\n');

  // Email resume
  try {
    const wn = state.weekStr.split('W')[1];
    await sendEmail(`Publication SEO S${wn} | ${published} articles | Groupe Genevoise`,
      `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <h2 style="color:#1a1a2e">Publication S${wn}</h2>
      <p style="color:#555"><strong>${published}</strong> publies | <strong>${failed}</strong> echecs</p>
      ${toPublish.map((a) => `<p style="font-size:13px;color:${a.status === 'published' ? '#27ae60' : '#e74c3c'}">
        ${a.status === 'published' ? '+' : '!'} "${esc(a.keyword)}" (${esc(SITE_LABELS[a.site] || a.site)})${a.publishedDocId ? ` — ${esc(a.publishedDocId)}` : ''}</p>`).join('')}
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
      <p style="color:#999;font-size:12px">Jarvis One | A26K Group</p></div>`);
  } catch (e) { logger.debug("catch silencieux", { error: e.message }); }
}

// ─── STATUS ──────────────────────────────────────────────────

function phaseStatus() {
  const state = loadPipelineState();
  if (!state) { console.log('Aucun pipeline actif.'); return; }

  console.log('========================================');
  console.log(`  Pipeline: ${state.id}`);
  console.log(`  Phase: ${state.phase}`);
  console.log(`  Cree: ${state.createdAt}`);
  console.log('========================================');

  if (state.reasoning) console.log(`\n  Strategie: ${state.reasoning}`);

  console.log(`\n  Articles (${state.articles.length}):`);
  for (const a of state.articles) {
    const icon = { planned: '.', approved: '~', dry_run_done: '+', dry_run_failed: '!', ready_for_review: '*', published: 'V', publish_failed: 'X' }[a.status] || '?';
    console.log(`  [${icon}] ${a.priority || '-'}. "${a.keyword}" (${SITE_LABELS[a.site] || a.site}) — ${a.status}${a.geoScore ? ` — GEO:${a.geoScore}` : ''}${a.imagesReady ? ' [IMG]' : ''}`);
  }

  console.log(`\n  Legende: . planned  ~ approved  + dry-run OK  * review  V published  ! failed`);
  console.log('========================================\n');
}

// ─── APPROVE ────────────────────────────────────────────────

function phaseApprove(keyword) {
  const state = loadPipelineState();
  if (!state) { console.error('Aucun pipeline actif.'); process.exit(1); }

  if (!keyword) {
    // Afficher tous les articles avec leur statut
    console.log('========================================');
    console.log('  Articles du pipeline:');
    console.log('========================================');
    for (const a of state.articles) {
      const icon = a.approved ? '✓' : '·';
      console.log(`  [${icon}] "${a.keyword}" (${SITE_LABELS[a.site] || a.site}) — ${a.status}`);
    }
    const pending = state.articles.filter((a) => !a.approved).length;
    console.log(`\n  ${state.articles.length - pending} approuve(s), ${pending} en attente`);
    console.log('========================================\n');
    return;
  }

  const art = state.articles.find((a) => a.keyword.toLowerCase() === keyword.toLowerCase());
  if (!art) { console.error(`Article "${keyword}" non trouve dans le pipeline.`); process.exit(1); }

  art.approved = true;
  art.status = 'approved';
  savePipelineState(state);
  console.log(`+ Approuve: "${art.keyword}" (${SITE_LABELS[art.site] || art.site})`);
}

function phaseApproveAll() {
  const state = loadPipelineState();
  if (!state) { console.error('Aucun pipeline actif.'); process.exit(1); }

  let count = 0;
  for (const a of state.articles) {
    if (!a.approved) {
      a.approved = true;
      a.status = 'approved';
      count++;
    }
  }
  savePipelineState(state);
  console.log(`+ ${count} article(s) approuve(s) (total: ${state.articles.length})`);
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case '--plan': return phasePlan();
    case '--execute': return phaseExecute();
    case '--publish': return phasePublish();
    case '--approve': return phaseApprove(args[1]);
    case '--approve-all': return phaseApproveAll();
    case '--status': return phaseStatus();
    default:
      console.log('Usage:');
      console.log('  node seo-orchestrator.js --plan         Analyse + plan + email');
      console.log('  node seo-orchestrator.js --execute      Dry-runs + briefs DA');
      console.log('  node seo-orchestrator.js --publish      Publication Sanity');
      console.log('  node seo-orchestrator.js --approve      Liste les articles en attente');
      console.log('  node seo-orchestrator.js --approve "kw" Approuve un article');
      console.log('  node seo-orchestrator.js --approve-all  Approuve tout le pipeline');
      console.log('  node seo-orchestrator.js --status       Etat du pipeline');
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => sentry.fatal(err));
}
