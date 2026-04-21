#!/usr/bin/env node
/**
 * seo-publish-article.js v5
 * v5: Article schema JSON-LD, source URLs verifiees, speakable markup,
 * sommaire/TOC, Claude retry, toutes features v4 preservees.
 * Jarvis One — Groupe Genevoise
 */
const sentry = require('./lib/sentry');
sentry.init({ script: 'seo-publish-article' });

const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  PATHS, CLAUDE_MODEL, logger, validateEnv, ensureDir, requireAnthropicKey, getApiKey,
  loadSecret, getSiteConfig, getSiteList,
  getSanityDefaults, getSanityDocType, getPersonaDetails, getSitePersonas,
  getSiteSources, getSiteEntity, getSiteFinma, getSiteStableSources,
  rateLimitedSemrushGet, rateLimitedSemrushRequest, tavilySearch, trackUnits, printUnitsSummary,
  callClaudeWithRetry, extractClaudeText, verifyUrl,
  httpRequest, readJSONSafe, writeJSONAtomic, withLockedJSON,
  TIMEOUTS, VALID_PERSONAS, sanitizeErrorMessage,
  createTaskResult, writeTaskResult, finalizeSuccess, finalizeError, ERROR_CODES,
} = require('./seo-shared');

// Sanity config from sites/config.json _meta
const _sanityDefaults = getSanityDefaults();
const SANITY_PROJECT_ID = _sanityDefaults.projectId || 'ttza946i';
const SANITY_DATASET = _sanityDefaults.dataset || 'production';
const SANITY_API_VERSION = _sanityDefaults.apiVersion || '2024-01-01';
const DEFAULT_AUTHOR_ID = _sanityDefaults.defaultAuthorId || '4cb740e5-5047-4314-b990-341542c463ee';
const DEFAULT_CATEGORY_ID = _sanityDefaults.defaultCategoryId || 'cef2817a-8116-4ec0-808a-ec9c5640a7a5';
const DEFAULT_IMAGE_ID = _sanityDefaults.defaultImageId || 'image-ae7c3ec3942f88ddbc1fa36cf5bcb48684f8393a-4096x2731-webp';

const VALID_SITES = getSiteList();

const DB_PATH = PATHS.db;
const JSON_TRACKING_PATH = PATHS.jsonTracking;

// ─── CLI, Persona Auto-Select, Anti-Duplication ─────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, preProd: false, draftOnly: false, force: false, enrich: false, personaAutoSelected: false, imagePath: null, imageAlt: null, outputJson: null, taskId: null };
  for (let i = 0; i < args.length; i++) { switch (args[i]) { case '--site': opts.site = args[++i]; break; case '--keyword': opts.keyword = args[++i]; break; case '--persona': opts.persona = args[++i]; break; case '--image-path': opts.imagePath = args[++i]; break; case '--image-alt': opts.imageAlt = args[++i]; break; case '--dry-run': opts.dryRun = true; break; case '--pre-prod': opts.preProd = true; break; case '--draft-only': opts.draftOnly = true; break; case '--force': opts.force = true; break; case '--enrich': opts.enrich = true; break; case '--output-json': opts.outputJson = args[++i]; break; case '--task-id': opts.taskId = args[++i]; break; } }
  if (!opts.site || !opts.keyword) { console.error('Usage: --site <s> --keyword <kw> [--persona <p>] [--image-path <f>] [--image-alt <t>] [--dry-run] [--pre-prod] [--draft-only] [--force] [--enrich]'); process.exit(1); }
  if (!VALID_SITES.includes(opts.site)) { console.error(`Site inconnu: "${opts.site}"`); process.exit(1); }
  if (opts.imagePath) {
    opts.imagePath = path.resolve(opts.imagePath);
    if (!fs.existsSync(opts.imagePath)) { console.error(`Image introuvable: "${opts.imagePath}"`); process.exit(1); }
    const ext = path.extname(opts.imagePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) { console.error(`Extension image non supportee: "${ext}"`); process.exit(1); }
  }
  if (!opts.persona) { opts.persona = autoSelectPersona(opts.site); opts.personaAutoSelected = true; }
  if (!VALID_PERSONAS.includes(opts.persona)) { console.error(`Persona inconnue: "${opts.persona}"`); process.exit(1); }
  if (!getSitePersonas(opts.site).includes(opts.persona)) { console.error(`"${opts.persona}" non associee a "${opts.site}"`); process.exit(1); }
  return opts;
}

function autoSelectPersona(site) {
  const avail = getSitePersonas(site);
  if (avail.length <= 1) return avail[0];
  const counts = {}; for (const n of avail) counts[n] = 0;
  for (const a of readJSONSafe(JSON_TRACKING_PATH, [])) { if (a.site === site && counts[a.persona] !== undefined) counts[a.persona]++; }
  try { const D = require('better-sqlite3'); if (fs.existsSync(DB_PATH)) { const db = new D(DB_PATH, { readonly: true }); for (const r of db.prepare('SELECT persona, COUNT(*) as cnt FROM articles WHERE site = ? GROUP BY persona').all(site)) { if (counts[r.persona] !== undefined) counts[r.persona] = Math.max(counts[r.persona], r.cnt); } db.close(); } } catch (e) { logger.debug("catch silencieux", { error: e.message }); }
  return Object.entries(counts).sort((a, b) => a[1] - b[1])[0][0];
}

function checkDuplicate(site, kw) {
  const k = kw.toLowerCase().trim();
  { const f = readJSONSafe(JSON_TRACKING_PATH, []).find((a) => a.site === site && a.keyword && a.keyword.toLowerCase().trim() === k); if (f) return f; }
  try { const D = require('better-sqlite3'); if (fs.existsSync(DB_PATH)) { const db = new D(DB_PATH, { readonly: true }); const r = db.prepare('SELECT * FROM articles WHERE site = ? AND LOWER(keyword) = ?').get(site, k); db.close(); if (r) return r; } } catch (e) { logger.debug("catch silencieux", { error: e.message }); }
  return null;
}

// HTTP loaded from seo-shared.js
const semrushGet = rateLimitedSemrushGet;

// Wrapper Claude with retry (from shared)
function callClaude(apiKey, system, user, maxTokens) {
  return callClaudeWithRetry(apiKey, system, user, maxTokens);
}

// ─── SQLite / JSON Tracking ──────────────────────────────────

function initDB() {
  try { const D = require('better-sqlite3'); const dir = path.dirname(DB_PATH); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); const db = new D(DB_PATH);
    db.exec(`CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY, site TEXT NOT NULL, keyword TEXT NOT NULL, keyword_en TEXT, persona TEXT, slug TEXT, geo_score INTEGER, geo_status TEXT, geo_visibility TEXT, published_at TEXT, j30_date TEXT, j60_date TEXT, j90_date TEXT, position_j0 INTEGER, position_j30 INTEGER, position_j60 INTEGER, position_j90 INTEGER, created_at TEXT DEFAULT (datetime('now'))); CREATE TABLE IF NOT EXISTS internal_links (from_slug TEXT, to_slug TEXT, site TEXT, suggested_at TEXT DEFAULT (datetime('now')));`);
    try { db.exec('ALTER TABLE articles ADD COLUMN geo_visibility TEXT'); } catch (e) { logger.debug("catch silencieux", { error: e.message }); }
    return db; } catch (e) { logger.debug('SQLite non disponible', { error: e.message }); return null; }
}

function trackArticle(db, data) {
  const n = { id: data.id, site: data.site, keyword: data.keyword, keyword_en: data.keywordEN || null, persona: data.persona, slug: data.slug, geo_score: data.geoScore, geo_status: data.geoStatus, geo_visibility: data.geoVisibility || null, published_at: data.publishedAt, j30_date: data.j30, j60_date: data.j60, j90_date: data.j90 };
  if (!db) {
    ensureDir(path.dirname(JSON_TRACKING_PATH));
    withLockedJSON(JSON_TRACKING_PATH, [], (arts) => { arts.push(n); });
    return;
  }
  db.prepare('INSERT OR REPLACE INTO articles (id,site,keyword,keyword_en,persona,slug,geo_score,geo_status,geo_visibility,published_at,j30_date,j60_date,j90_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(n.id, n.site, n.keyword, n.keyword_en, n.persona, n.slug, n.geo_score, n.geo_status, n.geo_visibility, n.published_at, n.j30_date, n.j60_date, n.j90_date);
}

// ─── Etape 1 : Brief ────────────────────────────────────────

async function buildBrief(apiKey, keyword) {
  console.log('\n> Etape 1 : Brief');
  let overview = {};
  try { const r = await semrushGet(`https://api.semrush.com/?type=phrase_all&key=${apiKey}&phrase=${encodeURIComponent(keyword)}&database=ch&export_columns=Ph,Nq,Kd,Cp,Co`); trackUnits('phrase_all', 1); const l = r.trim().split('\n'); if (l.length >= 2) { const h = l[0].split(';'), v = l[1].split(';'); h.forEach((hh, i) => { overview[hh.trim()] = v[i] ? v[i].trim() : ''; }); } } catch (e) { logger.warn(`overview: ${e.message}`); }
  let related = [];
  try { const r = await semrushGet(`https://api.semrush.com/?type=phrase_related&key=${apiKey}&phrase=${encodeURIComponent(keyword)}&database=ch&export_columns=Ph,Nq,Kd&display_limit=10`); const l = r.trim().split('\n'); if (l.length >= 2) related = l.slice(1).map((x) => { const p = x.split(';'); return { keyword: (p[0] || '').trim(), volume: p[1], difficulty: p[2] }; }).filter((x) => x.keyword); trackUnits('phrase_related', related.length); } catch (e) { logger.warn(`related: ${e.message}`); }
  let serpCompetitors = [];
  try { const r = await semrushGet(`https://api.semrush.com/?type=phrase_organic&key=${apiKey}&phrase=${encodeURIComponent(keyword)}&database=ch&export_columns=Dn,Ur&display_limit=5`); const l = r.trim().split('\n'); if (l.length >= 2) serpCompetitors = l.slice(1).map((x) => { const p = x.split(';'); return { domain: (p[0] || '').trim(), url: (p[1] || '').trim() }; }).filter((x) => x.domain); trackUnits('phrase_organic', serpCompetitors.length); } catch (e) { logger.warn(`SERP: ${e.message}`); }
  return { keyword, volume: overview['Search Volume'] || overview['Nq'] || 'N/A', difficulty: overview['Keyword Difficulty Index'] || overview['Kd'] || 'N/A', cpc: overview['CPC'] || overview['Cp'] || 'N/A', relatedKeywords: related, serpCompetitors };
}

// ─── Article JSON Schema Validation ──────────────────────────
// Validates, auto-fixes, and retries via Claude if critical fields are broken.

function validateArticleJSON(article) {
  const errors = [];    // fatal: need Claude repair
  const warnings = [];  // auto-fixable
  const fixes = [];     // applied automatically

  // --- Required fields ---
  if (!article.title || typeof article.title !== 'string') errors.push('title manquant ou invalide');
  if (!article.sections || !Array.isArray(article.sections) || article.sections.length === 0) errors.push('sections manquant ou vide');

  // --- Title length guard (SEO: max 70 chars) ---
  if (article.title && article.title.length > 70) {
    // Fallback: use metaTitle if already set and shorter, otherwise truncate at last word boundary
    if (article.metaTitle && article.metaTitle.length <= 70) {
      article.title = article.metaTitle;
      fixes.push(`title trop long (${article.title.length} chars) → remplacé par metaTitle`);
    } else {
      const truncated = article.title.slice(0, 70).replace(/\s\S+$/, '').trimEnd();
      article.title = truncated;
      fixes.push(`title tronqué à 70 chars: "${truncated}"`);
    }
  }

  // --- Auto-fixable fields ---
  if (!article.slug || typeof article.slug !== 'string') {
    if (article.title) {
      article.slug = article.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
      fixes.push('slug genere depuis title');
    } else {
      errors.push('slug manquant et title absent pour le generer');
    }
  }

  if (!article.summary || typeof article.summary !== 'string') {
    article.summary = '';
    fixes.push('summary initialise a vide');
  }

  if (!article.metaTitle || typeof article.metaTitle !== 'string') {
    article.metaTitle = (article.title || '').slice(0, 60);
    fixes.push('metaTitle copie depuis title');
  } else if (article.metaTitle.length > 65) {
    article.metaTitle = article.metaTitle.slice(0, 60);
    fixes.push('metaTitle tronque a 60 car.');
  }

  if (!article.metaDescription || typeof article.metaDescription !== 'string') {
    article.metaDescription = (article.summary || '').slice(0, 155);
    fixes.push('metaDescription copie depuis summary');
  } else if (article.metaDescription.length > 160) {
    article.metaDescription = article.metaDescription.slice(0, 155);
    fixes.push('metaDescription tronque a 155 car.');
  }

  // --- Array fields: normalize ---
  if (!Array.isArray(article.faq)) {
    article.faq = [];
    fixes.push('faq initialise a []');
  } else {
    // Validate each FAQ item
    article.faq = article.faq.filter((f) => f && typeof f.question === 'string' && typeof f.answer === 'string');
    if (article.faq.length === 0) warnings.push('faq vide apres filtrage (items invalides supprimes)');
  }

  if (!Array.isArray(article.citableExtracts)) {
    article.citableExtracts = [];
    fixes.push('citableExtracts initialise a []');
  } else {
    article.citableExtracts = article.citableExtracts.filter((e) => typeof e === 'string' && e.length > 10);
  }

  if (!Array.isArray(article.sourceUrls)) {
    article.sourceUrls = [];
    fixes.push('sourceUrls initialise a []');
  } else {
    article.sourceUrls = article.sourceUrls.filter((u) => typeof u === 'string' && u.startsWith('https://'));
  }

  // --- Sections deep validation ---
  if (Array.isArray(article.sections)) {
    for (let i = 0; i < article.sections.length; i++) {
      const s = article.sections[i];
      if (!s || typeof s !== 'object') { errors.push(`sections[${i}] n'est pas un objet`); continue; }
      if (!s.heading || typeof s.heading !== 'string') {
        s.heading = `Section ${i + 1}`;
        fixes.push(`sections[${i}].heading auto-genere`);
      }
      if (!s.content || typeof s.content !== 'string') {
        errors.push(`sections[${i}].content manquant`);
        s.content = ''; // prevent 'undefined' in downstream processing
        fixes.push(`sections[${i}].content initialise a vide`);
      } else if (s.content.split(/\s+/).length < 20) {
        warnings.push(`sections[${i}] tres courte (${s.content.split(/\s+/).length} mots)`);
      }
    }
    // Remove completely empty sections (no heading AND no content)
    article.sections = article.sections.filter((s) => s && (s.heading || s.content));
  }

  return { valid: errors.length === 0, errors, warnings, fixes };
}

function buildRepairPrompt(article, errors, warnings) {
  const issues = [...errors.map((e) => `ERREUR: ${e}`), ...warnings.map((w) => `AVERTISSEMENT: ${w}`)];
  return `L'article JSON suivant a des problemes de structure. Corrige UNIQUEMENT les champs problematiques sans modifier le reste du contenu.

Problemes:
${issues.map((is, i) => `${i + 1}. ${is}`).join('\n')}

Article actuel:
${JSON.stringify(article, null, 2)}

Retourne le JSON COMPLET corrige avec la meme structure:
{ "title", "slug", "summary", "sections": [{"heading","content"}], "faq": [{"question","answer"}], "citableExtracts": [...], "sourceUrls": [...], "metaTitle", "metaDescription" }`;
}

// ─── Etape 2 : Redaction FR (avec validation + repair) ───────

/**
 * Fetch real verified source URLs for the keyword.
 *
 * Strategy (priorité décroissante) :
 * 1. Tavily Search — 2 requêtes ciblées (sites officiels + contexte Suisse)
 * 2. Semrush phrase_organic — fallback si Tavily ne trouve rien
 * 3. Vérification HTTP (verifyUrl) — garde uniquement les URLs réellement accessibles
 *
 * @returns {Promise<string[]>} Up to 5 verified source URLs
 */
async function fetchVerifiedSources(keyword, semrushApiKey) {
  const candidates = [];
  const seen = new Set();
  const add = (url) => {
    if (url && url.startsWith('https://') && !seen.has(url)) {
      seen.add(url);
      candidates.push(url);
    }
  };

  // ── 1. Tavily Search (prioritaire) ──
  // Requête 1 : sources officielles suisses
  const tavilyResults1 = await tavilySearch(
    `${keyword} site officiel Suisse autorité`,
    { maxResults: 8, includeDomains: ['admin.ch', 'fmh.ch', 'finma.ch', 'fedlex.admin.ch', 'ofas.admin.ch', 'bag.admin.ch', 'seco.admin.ch', 'estv.admin.ch', 'ge.ch', 'vd.ch', 'sem.admin.ch'] }
  );
  tavilyResults1.forEach((r) => add(r.url));

  // Requête 2 : recherche générale Suisse si résultats insuffisants
  if (candidates.length < 3) {
    const tavilyResults2 = await tavilySearch(
      `${keyword} Suisse loi réglementation`,
      { maxResults: 8 }
    );
    tavilyResults2.forEach((r) => add(r.url));
  }

  if (candidates.length > 0) {
    logger.info(`fetchVerifiedSources: ${candidates.length} candidats Tavily trouvés`);
  }

  // ── 2. Fallback Semrush si Tavily ne trouve rien ──
  if (candidates.length === 0) {
    for (const db of ['ch', 'fr']) {
      try {
        const rows = await rateLimitedSemrushRequest({
          type: 'phrase_organic',
          key: semrushApiKey,
          phrase: keyword,
          database: db,
          display_limit: 15,
          export_columns: 'Ur,Dn,Po',
        });
        rows.forEach((r) => add(r.Ur || r.Url));
      } catch (e) { logger.warn(`fetchVerifiedSources Semrush (${db}): ${e.message}`); }
      if (candidates.length >= 10) break;
    }
    if (candidates.length > 0) logger.info(`fetchVerifiedSources: ${candidates.length} candidats Semrush (fallback)`);
  }

  if (candidates.length === 0) {
    logger.info('fetchVerifiedSources: aucune source trouvée (Tavily + Semrush) — Claude utilisera ses propres sources');
    return [];
  }

  // ── 3. Vérification HTTP ──
  const verified = [];
  for (const url of candidates) {
    if (verified.length >= 5) break;
    try {
      const result = await verifyUrl(url, 6000);
      if (result && result.ok) {
        verified.push(url);
        logger.info(`  + source vérifiée: ${url}`);
      }
    } catch (e) { /* skip */ }
  }

  logger.info(`fetchVerifiedSources: ${verified.length} source(s) vérifiée(s) injectée(s)`);
  return verified;
}

async function writeArticleFR(apiKey, site, keyword, persona, brief, patchInstructions, injectedSources) {
  console.log(patchInstructions ? '  -> Patch...' : '\n> Etape 2 : Redaction FR');
  const sources = getSiteSources(site);
  const stableSources = injectedSources && injectedSources.length > 0
    ? injectedSources
    : getSiteStableSources(site);
  const stableSourcesBlock = stableSources.length > 0
    ? `\nIMPORTANT: utilise UNIQUEMENT ces URLs exactes dans "sourceUrls" (verifiees et stables):\n${stableSources.join('\n')}\nNe pas inventer d'autres URLs.`
    : '';
  const relatedKws = brief.relatedKeywords.map((r) => r.keyword).join(', ');
  const serpCtx = brief.serpCompetitors.length > 0 ? `\nTop Google: ${brief.serpCompetitors.map((s) => s.domain).join(', ')}. Couvre leurs themes.` : '';

  const systemPrompt = `Tu es ${persona}, redacteur pour ${site}. Style: ${getPersonaDetails(persona).style}
Regles: pas de tiret cadratin, ancrage suisse (CHF, lois CH), chiffres precis, phrases courtes.
Sources officielles: ${sources}. Longueur: 1200-1800 mots.${stableSourcesBlock}
Structure: H1, intro, 4-6 H2 en questions, conclusion CTA. Mots-cles: ${relatedKws}${serpCtx}
IMPORTANT: dans chaque section, 1+ "citation-ready snippet" (20-40 mots, fait verifiable + chiffre + source).
IMPORTANT: cite des sources avec URLs completes (https://...) dans "sourceUrls".
JSON:
{ "title": "H1 - MAX 70 caractères, concis et accrocheur", "slug": "slug-url", "summary": "Resume 2 phrases",
  "sections": [{ "heading": "H2?", "content": "Texte (\\n\\n)" }],
  "faq": [{ "question": "Q", "answer": "R" }],
  "citableExtracts": ["Selon X, fait Y."],
  "sourceUrls": ["https://finma.ch/...", "https://fedlex.admin.ch/..."],
  "metaTitle": "60 car.", "metaDescription": "155 car." }`;

  const userPrompt = patchInstructions || `Article SEO: "${keyword}". Vol: ${brief.volume}/mois CH. KD: ${brief.difficulty}/100.`;

  // --- Attempt 1: generate article ---
  const response = await callClaude(apiKey, systemPrompt, userPrompt, 8000);
  const cleaned = extractClaudeText(response).replace(/```json\s?|```/g, '').trim();
  let article;
  try { article = JSON.parse(cleaned); } catch (e) {
    // JSON parse failed entirely — retry once with original prompt + strictness
    logger.warn(`JSON parse echoue, retry strict...`);
    const retryResp = await callClaude(apiKey, systemPrompt + '\n\nATTENTION: ta reponse precedente n\'etait pas du JSON valide. Retourne UNIQUEMENT du JSON, sans texte ni markdown autour.', userPrompt, 8000);
    const retryCleaned = extractClaudeText(retryResp).replace(/```json\s?|```/g, '').trim();
    try { article = JSON.parse(retryCleaned); } catch (e2) { throw new Error(`JSON invalide apres retry: ${retryCleaned.slice(0, 200)}. ${e2.message}`); }
  }

  // --- Validate ---
  let validation = validateArticleJSON(article);

  if (validation.fixes.length > 0) {
    console.log(`  ~ Auto-fix: ${validation.fixes.join(', ')}`);
  }
  if (validation.warnings.length > 0) {
    console.log(`  ~ Warnings: ${validation.warnings.join(', ')}`);
  }

  // --- Repair if structural errors ---
  if (!validation.valid) {
    console.log(`  ! Erreurs structurelles: ${validation.errors.join(', ')}`);
    console.log('  -> Repair via Claude...');
    try {
      const repairResp = await callClaude(apiKey, 'Corrige le JSON. Retourne UNIQUEMENT du JSON valide.', buildRepairPrompt(article, validation.errors, validation.warnings), 8000);
      const repairCleaned = extractClaudeText(repairResp).replace(/```json\s?|```/g, '').trim();
      const repaired = JSON.parse(repairCleaned);
      const revalidation = validateArticleJSON(repaired);
      if (revalidation.valid) {
        article = repaired;
        console.log(`  + Repair reussi (${revalidation.fixes.length} auto-fix appliques)`);
      } else {
        logger.warn(`Repair insuffisant, erreurs restantes: ${revalidation.errors.join(', ')}`);
        // Use the best version we have (original with auto-fixes applied)
      }
    } catch (e) {
      logger.warn(`Repair echoue: ${e.message}. Utilisation de la version auto-fixee.`);
    }
  }

  const wc = article.sections ? article.sections.map((s) => s.content || '').join(' ').split(/\s+/).length : 0;
  console.log(`  + "${article.title}" (${wc} mots, ${article.citableExtracts.length} citations, ${article.sourceUrls.length} sources)`);
  return article;
}

// ─── Etape 2b : Verify source URLs ──────────────────────────

async function verifySourceUrls(article) {
  const urls = article.sourceUrls || [];
  if (urls.length === 0) return [];
  console.log(`\n> Verification ${urls.length} source URLs...`);
  const results = await Promise.all(urls.map((u) => verifyUrl(u, 5000)));
  const valid = results.filter((r) => r.ok).map((r) => r.url);
  const broken = results.filter((r) => !r.ok);
  if (broken.length > 0) {
    console.log(`  ! ${broken.length} liens morts supprimes: ${broken.map((b) => b.url).join(', ')}`);
    article.sourceUrls = valid;
  }
  console.log(`  + ${valid.length} sources verifiees`);
  return valid;
}

// ─── Etape 3 : Traduction EN ─────────────────────────────────

async function translateToEN(apiKey, semrushKey, articleFR, keywordFR) {
  console.log('\n> Etape 3 : Traduction EN');
  let keywordEN = null;
  try {
    const tr = extractClaudeText(await callClaude(apiKey, '', `Translate this Swiss French SEO keyword to English. Return ONLY the keyword: "${keywordFR}"`, 100)).trim().replace(/"/g, '');
    const r = await semrushGet(`https://api.semrush.com/?type=phrase_all&key=${semrushKey}&phrase=${encodeURIComponent(tr)}&database=ch&export_columns=Ph,Nq`);
    trackUnits('phrase_all', 1);
    const l = r.trim().split('\n');
    if (l.length >= 2) { keywordEN = { keyword: tr, volume: parseInt(l[1].split(';')[1], 10) || 0 }; console.log(`  + KW EN: "${tr}" (vol: ${keywordEN.volume})`); }
  } catch (e) { logger.warn(`KW EN: ${e.message}`); }
  const resp = await callClaude(apiKey, `Translator FR->EN. Same JSON. British English. Keep CHF/FINMA.${keywordEN ? ` Optimize: "${keywordEN.keyword}".` : ''} Return JSON only.`, JSON.stringify(articleFR, null, 2));
  const cleaned = extractClaudeText(resp).replace(/```json\s?|```/g, '').trim();
  let articleEN; try { articleEN = JSON.parse(cleaned); } catch (e) { throw new Error(`Trad JSON: ${e.message}`); }
  return { articleEN, keywordEN };
}

// ─── Etape 4 : Score GEO (100 pts) ──────────────────────────

function computeGEOScore(article, label) {
  console.log(`\n> ${label || 'Etape 4 : Score GEO'}`);
  const fullText = [article.title || '', article.summary || '', ...article.sections.map((s) => (s.heading || '') + ' ' + (s.content || '')), ...(article.faq || []).map((f) => (f.question || '') + ' ' + (f.answer || ''))].join(' ');
  const scores = {};

  // P1 Cleanness (15)
  const iaP = ['il est important de', 'en conclusion', 'en resume', "tout d'abord", 'de plus', 'il convient de', 'il est essentiel', "n'hesitez pas", 'dans cet article', 'voyons ensemble'];
  scores.p1_cleanness = Math.max(0, 15 - iaP.filter((p) => fullText.toLowerCase().includes(p)).length * 3);

  // P2 Persona (20)
  const chf = (fullText.match(/CHF|francs?/gi) || []).length;
  const pct = (fullText.match(/\d+\s*%/g) || []).length;
  const sentences = fullText.split(/[.!?]+/).filter(Boolean);
  const shortR = sentences.length > 0 ? sentences.filter((s) => s.trim().split(/\s+/).length < 20).length / sentences.length : 0;
  scores.p2_persona = Math.min(20, Math.min(5, chf * 2) + Math.min(5, pct * 2) + Math.min(10, Math.round(shortR * 15)));

  // P3 GEO (25, was 30 — freed 5 for P7)
  let p3 = Math.min(5, article.sections.filter((s) => s.heading.includes('?')).length * 1.5);
  p3 += Math.min(5, sentences.filter((s) => { const w = s.trim().split(/\s+/).length; return w >= 15 && w <= 30 && /\d/.test(s); }).length);
  const ent = ['FINMA', 'LAMal', 'LPP', 'AVS', 'OFAS', 'SECO', 'FMH', 'Tardoc', 'SUVA', 'Geneve', 'Lausanne', 'Zurich', 'Berne', 'Vaud', 'LCA', 'LAA', 'RC Pro'];
  p3 += Math.min(8, ent.filter((e) => fullText.includes(e)).length * 2);
  p3 += Math.min(4, ['fedlex', 'admin.ch', 'finma.ch', 'fmh.ch'].filter((s) => fullText.toLowerCase().includes(s)).length * 2);
  p3 += (article.faq && article.faq.length >= 3) ? 3 : (article.faq && article.faq.length >= 1) ? 1 : 0;
  scores.p3_geo = Math.min(25, p3);

  // P4 Perplexity sliding window (15)
  const words = fullText.toLowerCase().split(/\s+/).filter(Boolean);
  const ws = 200;
  if (words.length <= ws) {
    const d = words.length > 0 ? new Set(words).size / words.length : 0;
    scores.p4_perplexity = d >= 0.45 ? 15 : Math.round(d / 0.45 * 15);
  } else {
    let td = 0, wc = 0;
    for (let i = 0; i <= words.length - ws; i += 100) { td += new Set(words.slice(i, i + ws)).size / ws; wc++; }
    const avg = wc > 0 ? td / wc : 0;
    scores.p4_perplexity = avg >= 0.45 ? 15 : Math.round(avg / 0.45 * 15);
  }

  // P5 Schema (10)
  scores.p5_schema = Math.min(10, (article.faq && article.faq.length > 0 ? 7 : 0) + (article.sections && article.sections.length >= 4 ? 3 : 0));

  // P6 Citations (10)
  const extracts = article.citableExtracts || [];
  scores.p6_citations = Math.min(10, extracts.filter((e) => { const w = e.split(/\s+/).length; return w >= 15 && w <= 50 && /\d/.test(e) && /selon|source|admin\.ch|finma|loi|chf/i.test(e); }).length * 3);

  // P7 Verified Sources (5) — NEW
  const srcCount = (article.sourceUrls || []).filter((u) => u.startsWith('https://')).length;
  scores.p7_sources = Math.min(5, srcCount * 2);

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const status = total >= 85 ? 'green' : total >= 65 ? 'yellow' : 'red';
  console.log(`  + GEO: ${total}/100 (${status.toUpperCase()})`);
  Object.entries(scores).forEach(([k, v]) => console.log(`    ${k}: ${v}`));
  return { total, status, breakdown: scores };
}

// ─── Topical Coverage + Patch ────────────────────────────────

async function checkTopicalCoverage(apiKey, article, brief) {
  console.log('\n> Topical Coverage');
  try {
    const themes = [brief.keyword, ...brief.relatedKeywords.map((r) => r.keyword)].join(', ');
    const resp = await callClaude(apiKey, 'Analyste SEO. Reponds JSON: { "score": 0-10, "covered": [], "missing": [], "suggestion": "" }',
      `Brief: "${brief.keyword}", themes: ${themes}\nArticle:\n${article.sections.map((s) => s.heading + ': ' + s.content.slice(0, 200)).join('\n')}`, 500);
    const r = JSON.parse(extractClaudeText(resp).replace(/```json\s?|```/g, '').trim());
    const score = typeof r.score === 'number' ? r.score : 5;
    console.log(`  + Coverage: ${score}/10 | Missing: ${(r.missing || []).join(', ') || 'aucun'}`);
    return { score, covered: r.covered || [], missing: r.missing || [], suggestion: r.suggestion || '' };
  } catch (e) { logger.warn(`${e.message}`); return { score: 5, covered: [], missing: [], suggestion: '' }; }
}

async function patchArticle(apiKey, site, keyword, persona, brief, article, geoScore, maxRetries, missingThemes) {
  let current = article, score = geoScore, attempt = 0;
  const shouldPatch = () => score.status === 'red' || score.total < 65;
  while (shouldPatch() && attempt < (maxRetries || 2)) {
    attempt++;
    const weak = [];
    if (score.breakdown.p1_cleanness < 10) weak.push('SUPPRIME patterns IA');
    if (score.breakdown.p2_persona < 12) weak.push('AJOUTE CHF, %, phrases courtes');
    if (score.breakdown.p3_geo < 15) weak.push('AJOUTE H2 questions, entites suisses, sources admin.ch');
    if (score.breakdown.p4_perplexity < 9) weak.push('DIVERSIFIE vocabulaire');
    if (score.breakdown.p6_citations < 5) weak.push('AJOUTE extraits citables "Selon [source], [fait]"');
    if (score.breakdown.p7_sources < 3) weak.push('AJOUTE des sourceUrls (https://admin.ch/...)');
    if (missingThemes && missingThemes.length > 0) weak.push(`COUVRE ces themes manquants: ${missingThemes.join(', ')}`);
    const prompt = `AMELIORE (pas reecrire):\n${weak.map((w, i) => `${i + 1}. ${w}`).join('\n')}\n\nArticle:\n${JSON.stringify(current, null, 2)}\n\nJSON complet corrige.`;
    current = await writeArticleFR(apiKey, site, keyword, persona, brief, prompt);
    score = computeGEOScore(current, `GEO (patch ${attempt})`);
  }
  return { article: current, geoScore: score };
}

// ─── Etape 5 : Disclaimer contextuel ────────────────────────

async function generateDisclaimer(apiKey, site, keyword) {
  const isFinma = !!getSiteFinma(site);
  try {
    const resp = await callClaude(apiKey, '', `Disclaimer legal UNIQUE (1 phrase, max 50 mots) pour article suisse sur "${keyword}" (${site}).${isFinma ? ` Mentionne: ${getSiteFinma(site)}.` : ''} Informatif, pas conseil juridique. Texte seul.`, 150);
    return extractClaudeText(resp).trim().replace(/^"|"$/g, '');
  } catch (e) { logger.warn(`Disclaimer generation echouee: ${e.message}`); return isFinma ? `Informations indicatives. Consultez un professionnel. ${getSiteFinma(site)}.` : 'Informations indicatives. Consultez un professionnel qualifie.'; }
}

// ─── GEO Visibility ─────────────────────────────────────────

async function checkGEOVisibility(apiKey, keyword, site) {
  console.log('\n> GEO Visibility');
  try {
    const resp = await callClaude(apiKey, 'Analyste GEO. JSON: { "visibility": "cited|partial|absent", "confidence": 0-10, "notes": "..." }',
      `"${keyword}" sur ${site}: serait-ce cite par Google AI Overview / Perplexity ?`, 300);
    const r = JSON.parse(extractClaudeText(resp).replace(/```json\s?|```/g, '').trim());
    const vis = r.visibility || 'unknown', conf = typeof r.confidence === 'number' ? r.confidence : 0;
    console.log(`  ${vis === 'cited' ? '+' : vis === 'partial' ? '~' : '-'} ${vis} (conf: ${conf}/10)`);
    return { visibility: vis, confidence: conf, notes: r.notes || '' };
  } catch (e) { logger.debug('GEO visibility check echoue', { error: e.message }); return { visibility: 'unknown', confidence: 0, notes: '' }; }
}

// ─── Maillage interne ────────────────────────────────────────

function findInternalLinks(site, slug, keyword) {
  let arts = [];
  arts = readJSONSafe(JSON_TRACKING_PATH, []);
  try { const D = require('better-sqlite3'); if (fs.existsSync(DB_PATH)) { const db = new D(DB_PATH, { readonly: true }); for (const r of db.prepare('SELECT slug, keyword, site FROM articles WHERE site = ?').all(site)) { if (!arts.find((a) => a.slug === r.slug)) arts.push(r); } db.close(); } } catch (e) { logger.debug("catch silencieux", { error: e.message }); }
  const kwW = keyword.toLowerCase().split(/\s+/);
  return arts.filter((a) => a.site === site && a.slug !== slug).map((a) => ({ slug: a.slug, keyword: a.keyword, overlap: kwW.filter((w) => (a.keyword || '').toLowerCase().includes(w) && w.length > 3).length })).filter((a) => a.overlap >= 1).sort((a, b) => b.overlap - a.overlap).slice(0, 3);
}

// ─── Publication Sanity ──────────────────────────────────────

function buildTOC(article) {
  return article.sections.map((s, i) => ({ _type: 'block', _key: `toc_${i}`, style: 'normal', children: [{ _type: 'span', _key: `tocs_${i}`, text: `${i + 1}. ${s.heading}`, marks: [] }], markDefs: [] }));
}

/**
 * Build Sanity body array: one wysiwygBlock per section + faqBlock.
 * Exhibits (photoZone) are inserted inside the correct section content.
 * Structure matches production schema:
 *   wysiwygBlock → blockTitle: { _type: 'document', title, content: [...blocks, ...photoZones] }
 *   faqBlock     → blockTitle: { title }, faqs: [{ _type: 'faqItem', question, answer }]
 */
function buildSanityBody(article, disclaimer, exhibitAssetIds, keyword) {
  let k = 0;
  const tb = (t, s) => ({ _type: 'block', _key: `b_${k++}`, style: s || 'normal', children: [{ _type: 'span', _key: `s_${k++}`, text: t, marks: [] }], markDefs: [] });
  const exhibits = exhibitAssetIds && exhibitAssetIds.length > 0 ? [...exhibitAssetIds] : [];

  // Compute exhibit insertion indices
  const totalSections = article.sections.length;
  const insertAfter = new Set();
  if (exhibits.length === 1) {
    insertAfter.add(Math.max(0, Math.floor(totalSections / 2) - 1));
  } else if (exhibits.length >= 2) {
    insertAfter.add(Math.max(0, Math.floor(totalSections / 3) - 1));
    insertAfter.add(Math.max(1, Math.floor((totalSections * 2) / 3) - 1));
  }

  const body = [];

  // One wysiwygBlock per section
  for (let i = 0; i < article.sections.length; i++) {
    const sec = article.sections[i];
    const content = [];

    // Section paragraphs
    for (const p of sec.content.split('\n\n').filter(Boolean)) content.push(tb(p));

    // Disclaimer in last section
    if (i === article.sections.length - 1) content.push(tb(disclaimer, 'blockquote'));

    // Exhibit (photoZone) after this section if applicable
    if (insertAfter.has(i) && exhibits.length > 0) {
      const ex = exhibits.shift();
      const photoAlt = (ex.altText || '').slice(0, 160);
      // imageTitle enrichi avec le keyword pour le SEO (crawlers), photoAlt reste descriptif (accessibilité)
      const imageTitle = `${keyword} — ${ex.altText || ''}`.slice(0, 160);
      content.push({
        _type: 'photoZone',
        _key: `exhibit_${k++}`,
        mainPhoto: {
          _type: 'document',
          imageTitle,
          photo: { _type: 'image', asset: { _type: 'reference', _ref: ex.assetId } },
          photoAlt,
        },
      });
    }

    body.push({
      _type: 'wysiwygBlock',
      _key: `w_sec_${k++}`,
      blockTitle: { _type: 'document', title: sec.heading, content },
    });
  }

  // faqBlock at body level — matches production schema
  if (article.faq && article.faq.length > 0) {
    body.push({
      _type: 'faqBlock',
      _key: `faq_main_${k++}`,
      blockTitle: { title: 'Questions fréquentes' },
      faqs: article.faq.map((f, i) => ({ _key: `fi_${i}_${k++}`, _type: 'faqItem', question: f.question, answer: f.answer })),
    });
  }

  return body;
}

function buildFAQSchema(article) {
  if (!article.faq || !article.faq.length) return null;
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: article.faq.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } })) };
}

function buildArticleSchema(article, site, persona, slug, lang) {
  return {
    '@context': 'https://schema.org', '@type': 'Article',
    headline: article.title, description: article.summary,
    author: { '@type': 'Person', name: persona, jobTitle: getPersonaDetails(persona).style ? getPersonaDetails(persona).style.split('.')[0] : 'Expert' },
    publisher: { '@type': 'Organization', name: getSiteEntity(site), url: `https://${site}` },
    datePublished: new Date().toISOString().split('T')[0],
    url: `https://${site}/blog/${slug.replace(/^(fr|en)-/, '')}`,
    inLanguage: lang === 'en' ? 'en' : 'fr-CH',
  };
}

function buildSpeakableSchema(article, site, slug) {
  const extracts = article.citableExtracts || [];
  if (extracts.length === 0) return null;
  return {
    '@context': 'https://schema.org', '@type': 'WebPage',
    url: `https://${site}/blog/${slug.replace(/^(fr|en)-/, '')}`,
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['.citable-extract'] },
  };
}

function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r.toISOString(); }

// ─── Sanity Image Asset Upload ──────────────────────────────

async function uploadImageToSanity(imagePath, seoFilename) {
  let token;
  try { const s = loadSecret('sanity'); token = s.token || s.api_token; } catch (e) { throw new Error(`Sanity token requis. ${e.message}`); }

  // Validate image file
  if (!fs.existsSync(imagePath)) throw new Error(`Image introuvable: ${imagePath}`);
  const imageBuffer = fs.readFileSync(imagePath);
  if (imageBuffer.length < 1024) throw new Error(`Image trop petite (${imageBuffer.length} bytes): ${imagePath}`);
  if (imageBuffer.length > 20 * 1024 * 1024) throw new Error(`Image trop grande (${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB): ${imagePath}`);

  const ext = path.extname(imagePath).toLowerCase().replace('.', '');
  const ALLOWED_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
  if (!ALLOWED_EXTS.includes(ext)) throw new Error(`Extension image non supportee: .${ext}`);
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  const contentType = mimeMap[ext];

  // Use SEO-friendly filename if provided, otherwise sanitize local filename
  const safeFilename = seoFilename
    ? `${seoFilename.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()}.${ext}`
    : path.basename(imagePath).replace(/[^a-zA-Z0-9._-]/g, '-');
  const url = `https://${SANITY_PROJECT_ID}.api.sanity.io/v${SANITY_API_VERSION}/assets/images/${SANITY_DATASET}?filename=${safeFilename}`;

  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const req = https.request({
      hostname: p.hostname, path: p.pathname + p.search, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': imageBuffer.length, Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error(`Sanity upload ${res.statusCode}: ${sanitizeErrorMessage(data.slice(0, 300))}`)); return; }
        try {
          const result = JSON.parse(data);
          const assetId = result.document ? result.document._id : null;
          if (!assetId) { reject(new Error(`Sanity upload: pas d'asset ID dans la reponse`)); return; }
          resolve(assetId);
        } catch (e) { reject(new Error(`Sanity upload parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUTS.sanity, () => { req.destroy(); reject(new Error(`Sanity upload timeout ${TIMEOUTS.sanity / 1000}s`)); });
    req.write(imageBuffer);
    req.end();
  });
}

async function publishToSanity(site, article, lang, persona, geoScore, disclaimer, imageAssetId, imageAlt, exhibitAssetIds, keyword) {
  let token; try { const s = loadSecret('sanity'); token = s.token || s.api_token; } catch (e) { throw new Error(`Sanity token requis. ${e.message}`); }
  const slug = `${lang}-${article.slug}`;
  const docId = `article-${slug.replace(/\//g, '-')}-${Date.now()}`;

  // Use uploaded image or fallback to default
  const imageRef = imageAssetId || DEFAULT_IMAGE_ID;
  // imageTitle = keyword-enriched for SEO crawlers (Sanity media library + structured data)
  // photoAlt  = descriptive for accessibility (screen readers, Google image search)
  const heroAlt = (imageAlt || article.title).slice(0, 125);
  const mainPhoto = {
    _type: 'document',
    imageTitle: `${keyword} — ${heroAlt}`.slice(0, 160),
    photo: { _type: 'image', asset: { _type: 'reference', _ref: imageRef } },
    photoAlt: heroAlt,
  };

  const doc = {
    _type: getSanityDocType(site), _id: docId,
    title: article.title, slug: { _type: 'slug', current: slug },
    summary: article.summary, language: lang,
    publishedDate: new Date().toISOString().split('T')[0],
    author: { _type: 'reference', _ref: DEFAULT_AUTHOR_ID },
    category: [{ _key: `cat_${Date.now()}`, _type: 'reference', _ref: DEFAULT_CATEGORY_ID }],
    mainPhoto,
    body: buildSanityBody(article, disclaimer, exhibitAssetIds, keyword),
    metaTitle: article.metaTitle || article.title, metaDescription: article.metaDescription || article.summary,
    persona, geoScore: geoScore.total, geoStatus: geoScore.status, disclaimer,
    publishedAt: new Date().toISOString(),
    trackingDates: { j30: addDays(new Date(), 30), j60: addDays(new Date(), 60), j90: addDays(new Date(), 90) },
    citableExtracts: article.citableExtracts || [], sourceUrls: article.sourceUrls || [],
  };
  // Schemas
  const faqSchema = buildFAQSchema(article); if (faqSchema) doc.faqSchema = JSON.stringify(faqSchema);
  const artSchema = buildArticleSchema(article, site, persona, slug, lang); doc.articleSchema = JSON.stringify(artSchema);
  const speakSchema = buildSpeakableSchema(article, site, slug); if (speakSchema) doc.speakableSchema = JSON.stringify(speakSchema);

  const url = `https://${SANITY_PROJECT_ID}.api.sanity.io/v${SANITY_API_VERSION}/data/mutate/${SANITY_DATASET}`;
  return { docId, slug, result: await httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ mutations: [{ createOrReplace: doc }] }) }) };
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  // PR 0.3 : initialize task result, shared with main().catch() via _pipelineResult
  const result = createTaskResult({
    taskId: opts.taskId,
    site: opts.site,
    keyword: opts.keyword,
    mode: opts.draftOnly ? 'draft' : 'publish',
  });
  _pipelineResult = result;
  console.log('========================================');
  console.log('  SEO Publisher v5');
  console.log(`  ${opts.site} | "${opts.keyword}" | ${opts.persona}${opts.personaAutoSelected ? ' (auto)' : ''}`);
  console.log(`  dry-run: ${opts.dryRun} | force: ${opts.force}${opts.enrich ? ' | enrich: true' : ''}`);
  console.log('========================================');

  const dup = checkDuplicate(opts.site, opts.keyword);
  if (dup && !opts.force) { console.error(`\n! DOUBLON: "${opts.keyword}" deja publie. --force pour forcer.`); finalizeError(result, { code: ERROR_CODES.DUPLICATE_KEYWORD, message: `Duplicate keyword: ${opts.keyword}`, stage: 'init', retryable: false }); writeTaskResult(opts.outputJson, result); process.exit(1); }
  if (dup && opts.force) console.log('  ! Doublon, --force actif');

  const semrush = loadSecret('semrush');
  const apiKey = requireAnthropicKey();
  const db = initDB();

  const brief = await buildBrief(semrush.api_key, opts.keyword);

  // Fetch real verified source URLs before writing (Semrush organic → HTTP check)
  console.log('\n> Sources : recherche URLs réelles via Semrush...');
  const verifiedSources = await fetchVerifiedSources(opts.keyword, semrush.api_key);
  if (verifiedSources.length > 0) {
    console.log(`  + ${verifiedSources.length} source(s) vérifiée(s) injectée(s) dans le prompt`);
    verifiedSources.forEach((u) => console.log(`    - ${u}`));
  } else {
    console.log('  ~ Aucune source Semrush trouvée — Claude utilisera ses propres sources');
  }

  let articleFR = await writeArticleFR(apiKey, opts.site, opts.keyword, opts.persona, brief, null, verifiedSources);

  // Verify source URLs
  await verifySourceUrls(articleFR);

  let geoScore = computeGEOScore(articleFR);
  let topicalCoverage = await checkTopicalCoverage(apiKey, articleFR, brief);

  if (geoScore.status === 'red' || topicalCoverage.score < 5 || (opts.enrich && topicalCoverage.score < 10)) {
    const missingToFill = (opts.enrich || topicalCoverage.score < 5) ? topicalCoverage.missing : [];
    const patched = await patchArticle(apiKey, opts.site, opts.keyword, opts.persona, brief, articleFR, geoScore, 2, missingToFill);
    articleFR = patched.article; geoScore = patched.geoScore;
    // Re-verify source URLs after patch (new URLs may be broken)
    await verifySourceUrls(articleFR);
    geoScore = computeGEOScore(articleFR, 'GEO (post-patch)');
    if (topicalCoverage.score < 5) topicalCoverage = await checkTopicalCoverage(apiKey, articleFR, brief);
  }

  const { articleEN, keywordEN } = await translateToEN(apiKey, semrush.api_key, articleFR, opts.keyword);
  const disclaimer = await generateDisclaimer(apiKey, opts.site, opts.keyword);
  console.log(`\n> Disclaimer: "${disclaimer.slice(0, 60)}..."`);
  const geoVisibility = await checkGEOVisibility(apiKey, opts.keyword, opts.site);
  const links = findInternalLinks(opts.site, articleFR.slug, opts.keyword);
  if (links.length > 0) { console.log(`\n> Maillage: ${links.length} liens`); links.forEach((l) => console.log(`  -> /${l.slug}`)); }

  if (opts.dryRun) {
    const output = { site: opts.site, keyword: opts.keyword, keywordEN, persona: opts.persona, brief, articleFR, articleEN, geoScore, topicalCoverage, geoVisibility, disclaimer, internalLinks: links, schemas: { faq: buildFAQSchema(articleFR), article: buildArticleSchema(articleFR, opts.site, opts.persona, articleFR.slug, 'fr'), speakable: buildSpeakableSchema(articleFR, opts.site, articleFR.slug) } };
    const dir = PATHS.reports;
    ensureDir(dir);
    const fp = path.join(dir, `article-dryrun-${opts.site.replace(/[^a-z0-9.-]/gi, '')}-${Date.now()}.json`);
    writeJSONAtomic(fp, output);
    console.log(`\n+ DRY RUN: ${fp}`);
    if (db) db.close();
    printUnitsSummary();
    return;
  }

  // ─── PRE PROD ──────────────────────────────────────────────
  // Génère texte + image hero + infographies, sans publier sur Sanity.
  // Envoie tout par email (PDF avec images embarquées).
  if (opts.preProd) {
    console.log('\n> MODE PRE-PROD : génération images + infographies (sans publication Sanity)');
    const { sendEmail } = require('./seo-shared');
    const { generateAndUploadImage } = require('./seo-images');
    const { generateExhibits } = require('./seo-exhibits');
    const siteConf = getSiteConfig(opts.site);
    const bflKey = getApiKey('BFL_API_KEY', 'bfl', 'api_key');

    // Image hero (BFL Flux, pas d'upload Sanity — sanityToken null)
    let heroImagePath = null;
    let heroAltText = opts.keyword;
    if (bflKey) {
      console.log('  -> Image hero...');
      try {
        const imgResult = await generateAndUploadImage(opts.keyword, siteConf ? siteConf.siteContext : {}, bflKey, null, false);
        if (imgResult && imgResult.filename) {
          heroImagePath = path.join(PATHS.images, imgResult.filename);
          heroAltText = imgResult.altText || opts.keyword;
          console.log(`  + Image hero: ${imgResult.filename}`);
        }
      } catch (e) { logger.warn(`Image hero pre-prod échouée: ${e.message}`); }
    }

    // Exhibits (infographies, dryRun=false → génère PNG local)
    let preProdExhibits = [];
    console.log('  -> Infographies...');
    try {
      const fullText = articleFR.sections.map((s) => `${s.heading}\n${s.content}`).join('\n\n');
      preProdExhibits = await generateExhibits(fullText, siteConf ? siteConf.siteContext : {}, opts.keyword, opts.site, articleFR.slug, false);
      console.log(`  + ${preProdExhibits.length} infographie(s) générée(s)`);
    } catch (e) { logger.warn(`Exhibits pre-prod échoués: ${e.message}`); }

    // Build HTML complet avec images embarquées en base64
    const toB64 = (p) => { try { return fs.readFileSync(p).toString('base64'); } catch (e) { return null; } };
    const heroB64 = heroImagePath ? toB64(heroImagePath) : null;
    const heroExt = heroImagePath ? path.extname(heroImagePath).replace('.', '') || 'jpg' : 'jpg';

    let htmlSections = '';
    let exhibitIdx = 0;
    const totalSections = articleFR.sections.length;
    const insertAfterPP = new Set();
    if (preProdExhibits.length === 1) insertAfterPP.add(Math.max(0, Math.floor(totalSections / 2) - 1));
    else if (preProdExhibits.length >= 2) { insertAfterPP.add(Math.max(0, Math.floor(totalSections / 3) - 1)); insertAfterPP.add(Math.max(1, Math.floor((totalSections * 2) / 3) - 1)); }

    for (let i = 0; i < articleFR.sections.length; i++) {
      const sec = articleFR.sections[i];
      htmlSections += `<h2>${sec.heading}</h2>`;
      for (const p of sec.content.split('\n\n').filter(Boolean)) htmlSections += `<p>${p}</p>`;
      if (insertAfterPP.has(i) && exhibitIdx < preProdExhibits.length) {
        const ex = preProdExhibits[exhibitIdx++];
        const exB64 = toB64(ex.pngPath);
        if (exB64) htmlSections += `<div class="exhibit"><img src="data:image/png;base64,${exB64}" alt="${ex.altText || ''}" style="max-width:100%;border:1px solid #e0e0e0;border-radius:4px;"/><p class="caption">${ex.altText || ''}</p></div>`;
      }
    }

    const faqHtml = articleFR.faq && articleFR.faq.length > 0
      ? `<h2>Questions fréquentes</h2>${articleFR.faq.map((f) => `<p class="faq-q">Q : ${f.question}</p><p>${f.answer}</p>`).join('')}`
      : '';

    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<style>
  body{font-family:Georgia,serif;max-width:800px;margin:40px auto;color:#1a1a2e;line-height:1.7;padding:0 20px}
  h1{color:#1a1a2e;font-size:24px;border-bottom:3px solid #2c5f7c;padding-bottom:10px}
  h2{color:#2c5f7c;font-size:18px;margin-top:28px}
  .meta{background:#f5f5f0;border-left:4px solid #2c5f7c;padding:10px 14px;margin:16px 0;font-size:13px}
  .badge{display:inline-block;background:#27ae60;color:white;padding:3px 8px;border-radius:3px;font-size:12px;margin-right:6px}
  .hero{width:100%;max-height:300px;object-fit:cover;border-radius:6px;margin:16px 0}
  .exhibit{margin:24px 0;text-align:center}
  .caption{font-size:13px;color:#666;font-style:italic;margin-top:6px}
  .faq-q{font-weight:bold;margin-top:14px}
  blockquote{background:#f9f9f4;border-left:3px solid #e8d5b7;padding:8px 14px;font-size:12px;color:#666;font-style:italic}
  .header{font-size:12px;color:#666;margin-bottom:20px}
</style></head><body>
<div class="header"><strong>PRE-PROD</strong> — medcourtage.ch — Persona: ${opts.persona}<br>
<span class="badge">GEO ${geoScore.total}/100</span><span class="badge" style="background:#2c5f7c">Coverage ${topicalCoverage.score}/10</span></div>
<h1>${articleFR.title}</h1>
<div class="meta"><strong>Meta title :</strong> ${articleFR.metaTitle || ''}<br><strong>Meta desc :</strong> ${articleFR.metaDescription || ''}<br><strong>Slug :</strong> /${articleFR.slug}</div>
<p><em>${articleFR.summary || ''}</em></p>
${heroB64 ? `<img class="hero" src="data:image/${heroExt};base64,${heroB64}" alt="${heroAltText}"/>` : '<p><em>[Image hero non disponible]</em></p>'}
${htmlSections}${faqHtml}
<blockquote>${disclaimer}</blockquote>
</body></html>`;

    // Générer PDF
    const ppDir = PATHS.reports; ensureDir(ppDir);
    const htmlPath = path.join(ppDir, `preprod-${opts.site.replace(/[^a-z0-9.-]/gi, '')}-${Date.now()}.html`);
    const pdfPath = htmlPath.replace('.html', '.pdf');
    fs.writeFileSync(htmlPath, html);

    await new Promise((resolve, reject) => {
      const { exec: execChild } = require('child_process');
      execChild(`wkhtmltopdf --page-size A4 --margin-top 15mm --margin-bottom 15mm --margin-left 15mm --margin-right 15mm --encoding utf-8 "${htmlPath}" "${pdfPath}"`, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    // Envoyer par email
    const pdfB64 = fs.readFileSync(pdfPath).toString('base64');
    const slug = articleFR.slug || opts.keyword.replace(/\s+/g, '-');
    await sendEmail(
      `[PRE-PROD] ${articleFR.title} | ${opts.site}`,
      `<p>Bonjour,</p><p>Voici le <strong>Pre-Prod</strong> de l'article avec images et infographies :</p>
<ul>
  <li><strong>Site :</strong> ${opts.site}</li>
  <li><strong>Keyword :</strong> ${opts.keyword}</li>
  <li><strong>Titre :</strong> ${articleFR.title}</li>
  <li><strong>GEO :</strong> ${geoScore.total}/100 (${geoScore.status})</li>
  <li><strong>Coverage :</strong> ${topicalCoverage.score}/10</li>
  <li><strong>Image hero :</strong> ${heroImagePath ? '✅ générée' : '❌ non disponible'}</li>
  <li><strong>Infographies :</strong> ${preProdExhibits.length} générée(s) (${preProdExhibits.filter((e) => e.usedClaudeStyle).length} avec Claude style)</li>
</ul>
<p>L'article complet avec images est en pièce jointe (PDF).</p>
<hr><p style="font-size:12px;color:#666;">Jarvis One · Chief Assistant · A26K Group · jarvis@groupe-genevoise.ch</p>`,
      [{ filename: `preprod-${slug}.pdf`, content: pdfB64 }]
    );
    console.log(`\n+ PRE-PROD email envoyé | PDF: ${pdfPath}`);
    if (db) db.close();
    printUnitsSummary();
    return;
  }

  // ─── DRAFT ONLY ────────────────────────────────────────────
  // Generates article but does NOT publish to Sanity.
  // Outputs DRAFT_JSON:{...} on stdout for caller to parse.
  if (opts.draftOnly) {
    console.log('\n> MODE DRAFT-ONLY : generation sans publication Sanity');

    // Generate exhibits in draft-only mode too
    let draftExhibits = [];
    try {
      const { generateExhibits } = require('./seo-exhibits');
      const siteConf = getSiteConfig(opts.site);
      const fullText = articleFR.sections.map(s => `${s.heading}\n${s.content}`).join('\n\n');
      const exhibitResults = await generateExhibits(fullText, siteConf ? siteConf.siteContext : {}, opts.keyword, opts.site, articleFR.slug, true);
      if (exhibitResults.length > 0) {
        console.log(`  + ${exhibitResults.length} exhibit(s) generated in draft mode`);
        for (const ex of exhibitResults) {
          draftExhibits.push({
            filename: ex.filename,
            altText: ex.altText,
            pngPath: ex.pngPath,
            svgPath: ex.svgPath || null,
            exhibitNumber: ex.filename.match(/-(\d+)/) ? parseInt(ex.filename.match(/-(\d+)/)[1]) : draftExhibits.length + 1,
          });
        }
      }
    } catch (e) {
      console.warn(`  ~ Exhibits draft skipped: ${e.message}`);
    }

    const draftJson = {
      title: articleFR.title,
      slug: articleFR.slug,
      summary: articleFR.summary,
      metaTitle: articleFR.metaTitle,
      metaDescription: articleFR.metaDescription,
      sections: articleFR.sections,
      faq: articleFR.faq,
      persona: opts.persona,
      disclaimer,
      sourceUrls: articleFR.sourceUrls || [],
      citableExtracts: articleFR.citableExtracts || [],
      exhibits: draftExhibits.map(ex => ({ altText: ex.altText, exhibitNumber: ex.exhibitNumber })),
    };
    console.log(`DRAFT_JSON:${JSON.stringify(draftJson)}`);
    // PR 0.3 : populate result with draft payload (mode: draft)
    result.draft = draftJson;
    result.scores = {
      geo: geoScore ? geoScore.total : null,
      geoStatus: geoScore ? geoScore.status : null,
      topicalCoverage: topicalCoverage ? topicalCoverage.score : null,
    };
    finalizeSuccess(result);
    writeTaskResult(opts.outputJson, result);
    console.log(`\n+ DRAFT generated: "${articleFR.title}"`);
    if (db) db.close();
    printUnitsSummary();
    return;
  }

  console.log('\n> Publication Sanity');

  // Upload image to Sanity if --image-path provided
  let imageAssetId = null;
  let imageAlt = opts.imageAlt || null;

  if (opts.imagePath) {
    // Manual image path takes priority
    console.log(`  -> Upload image manuelle: ${opts.imagePath}`);
    try {
      imageAssetId = await uploadImageToSanity(opts.imagePath);
      console.log(`  + Image asset: ${imageAssetId}`);
      // PR 0.3 : track hero image asset in result
      result.heroImage = { sanityAssetId: imageAssetId, source: 'manual', storagePath: opts.imagePath };
    } catch (err) {
      logger.warn(`Upload image echoue: ${err.message}. Image par defaut utilisee.`);
    }
  } else if (!opts.dryRun) {
    // Auto-generate image via Flux (DEV-001)
    console.log('\n> Etape image : Generation Flux (BFL)...');
    try {
      const { generateAndUploadImage } = require('./seo-images');
      const siteConf = getSiteConfig(opts.site);
      const bflKey = getApiKey('BFL_API_KEY', 'bfl', 'api_key');
      let sanityToken = null;
      try { const s = loadSecret('sanity'); sanityToken = s.token || s.api_token; } catch (e) { logger.debug('Sanity token indisponible pour upload image', { error: e.message }); }

      if (bflKey) {
        const imgResult = await generateAndUploadImage(
          opts.keyword,
          siteConf ? siteConf.siteContext : {},
          bflKey,
          sanityToken,
          false
        );
        if (imgResult && imgResult.assetId) {
          imageAssetId = imgResult.assetId;
          imageAlt = imgResult.altText || opts.keyword;
          console.log(`  + Image Sanity: ${imageAssetId}`);
        } else {
          logger.info('Image auto: pas d\'asset Sanity, fallback image par defaut');
        }
      } else {
        logger.info('BFL_API_KEY absente, image par defaut utilisee');
      }
    } catch (e) {
      logger.warn(`Image generation failed: ${e.message} — fallback image par defaut`);
      // Ne JAMAIS bloquer la publication si l'image echoue
    }
  }

  // ── Exhibit generation (Pipeline 2 + 3a + 3b + Agent 3) ──
  let exhibitResults = [];
  if (!opts.dryRun) {
    console.log('\n> Etape exhibits : Infographies de donnees...');
    try {
      const { generateExhibits } = require('./seo-exhibits');
      const siteConf = getSiteConfig(opts.site);
      const fullText = articleFR.sections.map((s) => `${s.heading}\n${s.content}`).join('\n\n');
      exhibitResults = await generateExhibits(
        fullText,
        siteConf ? siteConf.siteContext : {},
        opts.keyword,
        opts.site,
        articleFR.slug,
        false
      );
      if (exhibitResults.length > 0) {
        console.log(`  + ${exhibitResults.length} exhibit(s) genere(s)`);
        for (const ex of exhibitResults) {
          console.log(`    ${ex.filename} (${ex.usedClaudeStyle ? 'Claude stylisé' : 'SVG source'}, verifie: ${ex.verified})`);
        }
      } else {
        console.log('  ~ Aucun exhibit pertinent pour cet article');
      }
    } catch (e) {
      logger.warn(`Exhibits echoues: ${e.message} — publication continue sans exhibits`);
    }
  }

  // ── Upload exhibits to Sanity ──
  const exhibitAssetIds = [];
  if (exhibitResults.length > 0 && !opts.dryRun) {
    for (const ex of exhibitResults) {
      try {
        if (fs.existsSync(ex.pngPath)) {
          // SEO filename: keyword-slug-infographie-N (ex: assurance-maladie-suisse-infographie-1)
          const keywordSlug = opts.keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const seoFilename = `${keywordSlug}-infographie-${ex.filename.match(/-(\d+)[^/]*$/) ? ex.filename.match(/-(\d+)[^/]*$/)[1] : '1'}`;
          const assetId = await uploadImageToSanity(ex.pngPath, seoFilename);
          if (assetId) {
            exhibitAssetIds.push({ assetId, altText: ex.altText });
            console.log(`  + Exhibit upload: ${assetId} (${seoFilename})`);
          }
        }
      } catch (e) {
        logger.warn(`Exhibit upload echoue: ${e.message}`);
      }
    }
  }

  let publishedDocId = null;
  try {
    const resFR = await publishToSanity(opts.site, articleFR, 'fr', opts.persona, geoScore, disclaimer, imageAssetId, imageAlt, exhibitAssetIds, opts.keyword);
    console.log(`  + FR: ${resFR.docId}`);
    publishedDocId = resFR.docId;
    // PR 0.3 : populate result with Sanity doc + contentUrl
    result.sanity = {
      documentId: resFR.docId,
      slug: articleFR.slug,
      language: 'fr',
      documentType: getSanityDocType(opts.site),
    };
    result.contentUrl = `https://${opts.site}/blog/${articleFR.slug.replace(/^(fr|en)-/, '')}`;
    result.exhibits = (exhibitAssetIds || []).map((ex, i) => ({
      number: i + 1,
      sanityAssetId: ex.assetId,
      altText: ex.altText || null,
    }));
  } catch (err) { console.error(`  ! Sanity FR: ${err.message}`); err.errorCode = ERROR_CODES.SANITY_PUBLISH_FAILED; throw err; }
  try {
    const resEN = await publishToSanity(opts.site, articleEN, 'en', opts.persona, geoScore, disclaimer, imageAssetId, imageAlt, exhibitAssetIds, opts.keyword);
    console.log(`  + EN: ${resEN.docId}`);
  } catch (err) { console.error(`  ! Sanity EN: ${err.message}`); err.errorCode = ERROR_CODES.SANITY_PUBLISH_FAILED; throw err; }
  if (publishedDocId) {
    const now = new Date();
    trackArticle(db, { id: publishedDocId, site: opts.site, keyword: opts.keyword, keywordEN: keywordEN ? keywordEN.keyword : null, persona: opts.persona, slug: articleFR.slug, geoScore: geoScore.total, geoStatus: geoScore.status, geoVisibility: geoVisibility.visibility, publishedAt: now.toISOString(), j30: addDays(now, 30), j60: addDays(now, 60), j90: addDays(now, 90) });
    console.log('  + Tracke');
  }
  if (db) db.close();

  console.log('\n========================================');
  console.log(`+ GEO: ${geoScore.total}/100 | Visibility: ${geoVisibility.visibility} | Coverage: ${topicalCoverage.score}/10`);
  console.log(`  Citations: ${(articleFR.citableExtracts || []).length} | Sources: ${(articleFR.sourceUrls || []).length} | Links: ${links.length}`);
  printUnitsSummary();
  console.log('========================================\n');
  // PR 0.3 : populate final scores + finalize success + write JSON
  result.scores = {
    geo: geoScore.total,
    geoStatus: geoScore.status,
    geoVisibility: geoVisibility.visibility,
    topicalCoverage: topicalCoverage.score,
  };
  finalizeSuccess(result);
  writeTaskResult(opts.outputJson, result);
}

// PR 0.3 : result partage avec main().catch() pour ecrire l'erreur
let _pipelineResult = null;

if (require.main === module) {
  main().catch((err) => {
    try {
      if (_pipelineResult) {
        const code = err.errorCode
                   || (/circuit/i.test(err.message) ? ERROR_CODES.CLAUDE_CIRCUIT_OPEN
                     : /semrush/i.test(err.message) ? ERROR_CODES.SEMRUSH_API_FAILED
                     : ERROR_CODES.UNKNOWN);
        finalizeError(_pipelineResult, { code, message: err.message, stage: 'pipeline', retryable: false });
        // opts.outputJson may not be reachable here; fallback via argv parse
        const idx = process.argv.indexOf('--output-json');
        const outPath = idx !== -1 ? process.argv[idx + 1] : null;
        writeTaskResult(outPath, _pipelineResult);
      }
    } catch (_) { /* never block sentry.fatal */ }
    sentry.fatal(err);
  });
}

module.exports = { publishToSanity, uploadImageToSanity, buildSanityBody, generateDisclaimer };
