#!/usr/bin/env node
/**
 * seo-exhibits.js
 * Pipeline de generation d'exhibits (infographies de donnees) style BCG.
 *
 * Pipeline 2:  Claude → JSON structure des donnees
 * Pipeline 3a: Claude → SVG pixel-perfect style BCG
 * Pipeline 3b: Gemini image-to-image (style editorial du site)
 * Agent 3:     Claude Vision — verification integrite texte + lisibilite
 *
 * Types d'exhibits: comparison | process | breakdown | ranking | metric_highlight | matrix
 *
 * Jarvis One — Groupe Genevoise
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  PATHS, CLAUDE_MODEL, logger, ensureDir,
  callClaudeWithRetry, extractClaudeText, requireAnthropicKey, getApiKey,
  sanitizeSlug, sanitizeErrorMessage,
  readJSONSafe, writeJSONAtomic,
  TIMEOUTS, circuitBreakers, getSiteConfig, getSiteExhibitStyle,
} = require('./seo-shared');

const EXHIBITS_DIR = path.join(PATHS.images, 'exhibits');
const MAX_GEMINI_RETRIES = 3;

// ═══════════════════════════════════════════════════════════════
// EXHIBIT TYPES
// ═══════════════════════════════════════════════════════════════

const EXHIBIT_TYPES = ['comparison', 'process', 'breakdown', 'ranking', 'metric_highlight', 'matrix'];

// ═══════════════════════════════════════════════════════════════
// AGENT 0 — Exhibit Planning (integrated into image Agent 0)
// ═══════════════════════════════════════════════════════════════

/**
 * Analyse an article and identify 0-2 exhibit opportunities.
 * Returns an array of exhibit briefs.
 */
async function planExhibits(apiKey, articleText, siteContext, keyword) {
  logger.info('Exhibit Agent 0: analyse de l\'article pour exhibits');

  const system = `Tu es un directeur editorial pour un cabinet de conseil suisse.
Tu analyses un article SEO et identifies les "moments de preuve" — les passages
ou un exhibit visuel de donnees (style BCG/McKinsey) apporterait plus de valeur
qu'un paragraphe de texte.

Types d'exhibits disponibles:
- comparison: compare 2-3 options cote a cote (ex: SA vs Sarl)
- process: etapes sequentielles (ex: 6 etapes creation SA)
- breakdown: decomposition d'un tout en parties (ex: repartition couts)
- ranking: classement d'elements (ex: top 5 cantons)
- metric_highlight: 2-4 chiffres cles mis en avant (ex: CHF 100'000, 3-5 semaines)
- matrix: croisement de 2 dimensions (ex: risque vs cout)

Regles:
- Maximum 2 exhibits par article
- Un exhibit DOIT contenir des donnees factuelles (chiffres, comparaisons, etapes concretes)
- Ne propose PAS d'exhibit si l'article est purement narratif sans donnees
- Le titre de l'exhibit est une CONCLUSION, pas une description
  BON: "La SA coute 5x plus cher mais ouvre la porte aux investisseurs"
  MAUVAIS: "Comparaison SA et Sarl"
- Chaque exhibit doit etre autonome (comprehensible sans lire l'article)

Reponds JSON:
{
  "exhibits": [
    {
      "type": "comparison|process|breakdown|ranking|metric_highlight|matrix",
      "title": "Titre editorial (conclusion, pas description)",
      "data_context": "Quelles donnees extraire de l'article pour cet exhibit",
      "exhibit_number": 1,
      "placement_hint": "Apres quelle section de l'article"
    }
  ]
}

Si aucun exhibit n'est pertinent, retourne: { "exhibits": [] }`;

  const user = `Article (${keyword}):\n${articleText.slice(0, 6000)}\n\nContexte site: ${siteContext.secteur || ''} — ${siteContext.ton || ''}`;

  try {
    const resp = await callClaudeWithRetry(apiKey, system, user, 1500);
    const text = extractClaudeText(resp).replace(/```json\s?|```/g, '').trim();
    const parsed = JSON.parse(text);
    const exhibits = (parsed.exhibits || []).filter((e) => EXHIBIT_TYPES.includes(e.type)).slice(0, 2);
    logger.info(`Exhibit Agent 0: ${exhibits.length} exhibit(s) identifies`);
    return exhibits;
  } catch (e) {
    logger.warn(`Exhibit Agent 0 echoue: ${e.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE 2 — Data Extraction (Claude → JSON structuré)
// ═══════════════════════════════════════════════════════════════

/**
 * Extract structured data for a single exhibit from the article.
 */
async function extractExhibitData(apiKey, articleText, exhibitBrief, keyword) {
  logger.info(`Pipeline 2: extraction donnees "${exhibitBrief.title.slice(0, 50)}..."`);

  const system = `Tu es un analyste de donnees pour un cabinet de conseil suisse.
Tu extrais les donnees structurees d'un article pour creer un exhibit visuel.

L'exhibit demande est de type: ${exhibitBrief.type}
Titre: ${exhibitBrief.title}
Contexte: ${exhibitBrief.data_context}

Retourne un JSON avec les donnees EXACTES de l'article.
Tous les chiffres doivent etre en CHF suisse avec apostrophes (CHF 100'000).
Toutes les references legales doivent etre exactes.

Format selon le type:

Pour "comparison":
{
  "type": "comparison",
  "title": "Titre editorial",
  "takeaway": "La conclusion en 1 phrase",
  "columns": [
    { "header": "Option A", "highlight": true|false, "rows": { "Critere 1": "Valeur", ... } },
    { "header": "Option B", "highlight": true|false, "rows": { "Critere 1": "Valeur", ... } }
  ],
  "source": "Art. XXX CO — fedlex.admin.ch"
}

Pour "process":
{
  "type": "process",
  "title": "Titre editorial",
  "takeaway": "La conclusion en 1 phrase",
  "steps": [
    { "number": 1, "label": "Nom etape", "duration": "Semaine 1-2", "detail": "Description courte", "actor": "Notaire|Banque|RC|..." }
  ],
  "source": "..."
}

Pour "metric_highlight":
{
  "type": "metric_highlight",
  "title": "Titre editorial",
  "takeaway": "...",
  "metrics": [
    { "value": "CHF 100'000", "label": "Capital minimum SA", "context": "dont 50% a liberer" }
  ],
  "source": "..."
}

Pour "breakdown":
{
  "type": "breakdown",
  "title": "...",
  "takeaway": "...",
  "total": "Valeur totale",
  "parts": [ { "label": "Partie", "value": "Montant", "percent": "XX%" } ],
  "source": "..."
}

Pour "ranking":
{
  "type": "ranking",
  "title": "...",
  "takeaway": "...",
  "items": [ { "rank": 1, "label": "Element", "value": "Valeur", "detail": "..." } ],
  "source": "..."
}

Pour "matrix":
{
  "type": "matrix",
  "title": "...",
  "takeaway": "...",
  "axis_x": "Dimension horizontale",
  "axis_y": "Dimension verticale",
  "cells": [ { "x": "Cat X", "y": "Cat Y", "value": "Valeur" } ],
  "source": "..."
}`;

  const user = `Article (${keyword}):\n${articleText.slice(0, 6000)}`;

  try {
    const resp = await callClaudeWithRetry(apiKey, system, user, 2000);
    const text = extractClaudeText(resp).replace(/```json\s?|```/g, '').trim();
    const data = JSON.parse(text);
    if (!data.type || !data.title) throw new Error('JSON exhibit invalide');
    logger.info(`Pipeline 2: donnees extraites (${data.type}), ${JSON.stringify(data).length} chars`);
    return data;
  } catch (e) {
    logger.warn(`Pipeline 2 echoue: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE 3a — SVG Render (Claude → SVG pixel-perfect)
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a pixel-perfect SVG exhibit from structured data.
 */
async function renderExhibitSVG(apiKey, exhibitData, exhibitNumber, exhibitStyle) {
  logger.info(`Pipeline 3a: generation SVG exhibit ${exhibitNumber}`);

  const accentColor = exhibitStyle.accentColor || '#1a1a2e';
  const accentLight = exhibitStyle.accentColorLight || '#f0f0f0';

  const system = `Tu es un designer de data visualization pour un cabinet de conseil suisse premium (style BCG).
Tu generes un SVG pur qui sera rasterise en PNG haute resolution.

STYLE OBLIGATOIRE:
- Fond blanc pur (#ffffff)
- Texte principal noir (#1a1a1a)
- Couleur accent: ${accentColor}
- Couleur accent claire (headers): ${accentLight}
- Typographie sans-serif (font-family: system-ui, -apple-system, sans-serif)
- Separateurs fins (0.5px, #e0e0e0)
- AUCUNE decoration, aucune icone, aucune illustration
- AUCUN arrondi excessif (rx=2 maximum)
- Espacement genereux, beaucoup de blanc

STRUCTURE D'UN EXHIBIT (de haut en bas):
1. "EXHIBIT ${exhibitNumber}" en petites capitales, couleur accent, 11px, letter-spacing 2px
2. Titre editorial en noir, 22px, font-weight 500, max 2 lignes
3. Ligne horizontale fine accent (2px epaisseur, 40px largeur)
4. Le tableau/visuel de donnees (adapte au type)
5. "Source: ..." en gris #888, 10px, en bas

DIMENSIONS: viewBox="0 0 960 [hauteur adaptee]", width="960"
La hauteur depend du contenu. Prevois 60px par ligne de tableau.

REGLES ABSOLUES:
- Chaque texte doit etre un element <text> SVG (pas de foreignObject)
- Tous les chiffres et mots doivent etre EXACTEMENT ceux fournis dans les donnees
- Le SVG doit etre autonome (pas de CSS externe, pas de fonts externes)
- Pas de commentaires HTML dans le SVG
- Retourne UNIQUEMENT le SVG, rien d'autre (pas de markdown, pas de texte avant/apres)

POUR TYPE "comparison":
- 2-3 colonnes cote a cote avec un header accent
- Premiere colonne = labels des criteres (gris, aligne gauche)
- Colonnes suivantes = valeurs (noir, aligne gauche)
- Header de la colonne "highlight" a un fond accent

POUR TYPE "process":
- Etapes verticales numerotees
- Chaque etape: numero (cercle accent) + label + duration badge + detail
- Ligne verticale fine reliant les etapes

POUR TYPE "metric_highlight":
- 2-4 cartes en ligne
- Chiffre principal en grand (28px, font-weight 500)
- Label en dessous (13px, gris)
- Contexte en petit (11px, gris clair)

POUR TYPE "breakdown":
- Barre horizontale segmentee (proportionnelle aux %)
- Legende en dessous avec label + valeur + %

POUR TYPE "ranking":
- Liste numerotee avec barres horizontales proportionnelles
- Rang + label + valeur + barre

POUR TYPE "matrix":
- Grille 2D avec headers en accent
- Cellules avec valeurs`;

  const user = `Donnees de l'exhibit:\n${JSON.stringify(exhibitData, null, 2)}`;

  try {
    const resp = await callClaudeWithRetry(apiKey, system, user, 4000);
    let svg = extractClaudeText(resp).trim();

    // Clean: remove markdown fencing if present
    svg = svg.replace(/```svg\s?|```xml\s?|```/g, '').trim();

    // Validate SVG
    if (!svg.startsWith('<svg') && !svg.startsWith('<?xml')) {
      // Try to extract SVG from response
      const match = svg.match(/<svg[\s\S]*<\/svg>/);
      if (match) svg = match[0];
      else throw new Error('Response ne contient pas de SVG valide');
    }

    // Remove XML declaration if present
    svg = svg.replace(/<\?xml[^?]*\?>\s*/g, '');

    // Sanitize SVG — remove any script/event handlers that could cause XSS
    svg = svg.replace(/<script[\s\S]*?<\/script>/gi, '');
    svg = svg.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '');       // onclick, onload, etc.
    svg = svg.replace(/javascript\s*:/gi, 'blocked:');               // javascript: URLs
    svg = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, ''); // foreignObject can embed HTML
    svg = svg.replace(/xlink:href\s*=\s*["']javascript:[^"']*["']/gi, ''); // xlink javascript

    // Size guard
    if (svg.length > 500000) {
      logger.warn('Pipeline 3a: SVG trop grand (>500KB), tronque');
      throw new Error('SVG trop grand');
    }

    logger.info(`Pipeline 3a: SVG genere (${svg.length} chars)`);
    return svg;
  } catch (e) {
    logger.warn(`Pipeline 3a echoue: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// SVG → PNG Rasterization (Sharp)
// ═══════════════════════════════════════════════════════════════

/**
 * Rasterize SVG string to PNG buffer at 2x resolution.
 */
async function rasterizeSVG(svgString) {
  let sharp;
  try { sharp = require('sharp'); }
  catch { logger.warn('Sharp non installe, rasterisation impossible'); return null; }

  try {
    const svgBuffer = Buffer.from(svgString, 'utf-8');
    const pngBuffer = await sharp(svgBuffer, { density: 192 }) // 2x for retina
      .png({ quality: 95 })
      .toBuffer();

    logger.info(`Rasterisation: SVG → PNG (${(pngBuffer.length / 1024).toFixed(0)}KB)`);
    return pngBuffer;
  } catch (e) {
    logger.warn(`Rasterisation echouee: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE 3b — Gemini Image-to-Image
// ═══════════════════════════════════════════════════════════════

/**
 * Send PNG to Gemini 3 Pro Image for editorial styling.
 * Returns the styled PNG buffer or null on failure.
 */
async function geminiStyleTransfer(pngBuffer, exhibitStyle) {
  // Circuit breaker check
  if (!circuitBreakers.gemini.canExecute()) {
    logger.warn('Gemini circuit breaker OUVERT — skip styling');
    return null;
  }

  const geminiKey = getApiKey('GEMINI_API_KEY', 'google-gemini', 'api_key');
  if (!geminiKey) {
    logger.info('Gemini API key absente — skip styling, utilisation du SVG rasterise');
    return null;
  }

  const accentColor = exhibitStyle.accentColor || '#1a1a2e';
  const accentLight = exhibitStyle.accentColorLight || '#f0f0f0';
  const directive = exhibitStyle.geminiDirective || 'Premium Swiss financial consulting editorial style';

  const prompt = `You are a premium editorial art director. You receive a data exhibit (table/chart) as a source image.

YOUR TASK: Recreate this exhibit with refined editorial polish.

ABSOLUTE RULES — VIOLATION = REJECT:
- Do NOT modify, translate, rephrase, or omit ANY text
- Every word, number, CHF amount, percentage, and symbol must be IDENTICAL to the source image
- Keep the exact same layout structure (columns, rows, headers)
- Keep the exact same data hierarchy
- All text must remain in French

WHAT YOU MAY ENHANCE:
- Typography: refine letter-spacing, weight, alignment
- Background: add subtle paper or canvas texture
- Colors: apply the accent palette below
- Borders: refine line weights, add subtle shadows
- Spacing: improve visual breathing room
- Overall polish: make it feel like a premium consulting report page

SITE STYLE: ${directive}

ACCENT PALETTE:
- Primary: ${accentColor}
- Light fill: ${accentLight}
- Text: near-black #1a1a1a on white
- Background: white with subtle warm texture

OUTPUT: Single image, same aspect ratio as source, high resolution.`;

  const base64Image = pngBuffer.toString('base64');

  const body = JSON.stringify({
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'image/png', data: base64Image } },
        { text: prompt }
      ]
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      imageMimeType: 'image/png'
    }
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${geminiKey}`;

  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const req = https.request({
      hostname: p.hostname,
      path: p.pathname + p.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
        // Response size guard: 50MB max (Gemini returns base64 images inline)
        if (data.length > 50 * 1024 * 1024) {
          req.destroy();
          reject(new Error('Gemini: reponse trop grande (>50MB)'));
        }
      });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Gemini ${res.statusCode}: ${sanitizeErrorMessage(data.slice(0, 300))}`));
          return;
        }
        try {
          const resp = JSON.parse(data);
          // Extract image from Gemini response
          const parts = resp.candidates && resp.candidates[0] && resp.candidates[0].content && resp.candidates[0].content.parts;
          if (!parts) { reject(new Error('Gemini: pas de parts dans la reponse')); return; }

          const imagePart = parts.find((p) => p.inline_data && p.inline_data.mime_type && p.inline_data.mime_type.startsWith('image/'));
          if (!imagePart) { reject(new Error('Gemini: pas d\'image dans la reponse')); return; }

          const imgBuffer = Buffer.from(imagePart.inline_data.data, 'base64');
          if (imgBuffer.length < 5000) { reject(new Error(`Gemini: image trop petite (${imgBuffer.length} bytes)`)); return; }
          if (imgBuffer.length > 20 * 1024 * 1024) { reject(new Error(`Gemini: image trop grande (${(imgBuffer.length / 1024 / 1024).toFixed(1)}MB)`)); return; }

          resolve(imgBuffer);
        } catch (e) {
          reject(new Error(`Gemini parse: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUTS.flux, () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Gemini style transfer with retries (max 3).
 */
async function geminiStyleTransferWithRetry(pngBuffer, exhibitStyle) {
  const delays = [2000, 4000, 8000];
  for (let i = 0; i <= MAX_GEMINI_RETRIES; i++) {
    try {
      const result = await geminiStyleTransfer(pngBuffer, exhibitStyle);
      if (result) circuitBreakers.gemini.recordSuccess();
      return result;
    } catch (e) {
      logger.warn(`Gemini tentative ${i + 1}/${MAX_GEMINI_RETRIES + 1} echouee: ${e.message}`);
      circuitBreakers.gemini.recordFailure();
      if (i >= MAX_GEMINI_RETRIES) return null;
      await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// AGENT 3 — Vérificateur d'intégrité
// ═══════════════════════════════════════════════════════════════

/**
 * Compare source (SVG rasterized) and Gemini output using Claude Vision.
 * Checks text integrity, layout preservation, and legibility.
 * Returns { verdict, recommendation, details }.
 */
async function verifyExhibitIntegrity(apiKey, sourcePngBuffer, geminiPngBuffer, expectedData) {
  logger.info('Agent 3: verification integrite exhibit');

  const sourceB64 = sourcePngBuffer.toString('base64');
  const geminiB64 = geminiPngBuffer.toString('base64');

  // Build the list of expected text elements for the prompt
  const expectedTexts = [];
  if (expectedData.title) expectedTexts.push(expectedData.title);
  if (expectedData.takeaway) expectedTexts.push(expectedData.takeaway);
  if (expectedData.source) expectedTexts.push(expectedData.source);

  // Extract all values from the data
  if (expectedData.columns) {
    for (const col of expectedData.columns) {
      expectedTexts.push(col.header);
      for (const [k, v] of Object.entries(col.rows || {})) {
        expectedTexts.push(k, String(v));
      }
    }
  }
  if (expectedData.steps) {
    for (const s of expectedData.steps) {
      expectedTexts.push(s.label, s.duration || '', s.detail || '');
    }
  }
  if (expectedData.metrics) {
    for (const m of expectedData.metrics) {
      expectedTexts.push(m.value, m.label, m.context || '');
    }
  }
  if (expectedData.parts) {
    for (const p of expectedData.parts) {
      expectedTexts.push(p.label, String(p.value), p.percent || '');
    }
  }
  if (expectedData.items) {
    for (const it of expectedData.items) {
      expectedTexts.push(it.label, String(it.value));
    }
  }

  const cleanExpected = expectedTexts.filter((t) => t && t.trim()).map((t) => t.trim());

  const system = `Tu es un verificateur d'integrite pour des exhibits de donnees financieres suisses.
Tu recois 2 images:
- IMAGE 1 : la source de verite (SVG rasterise, donnees exactes)
- IMAGE 2 : la version stylisee (Gemini)

Tu dois comparer les deux avec une precision ABSOLUE.

VERIFICATIONS OBLIGATOIRES:

1. INTEGRITE DU TEXTE (score /10)
   Compare chaque element textuel entre les 2 images:
   - Chaque montant CHF doit etre identique (CHF 100'000 ≠ CHF 100.000 ≠ CHF 100,000)
   - Chaque pourcentage doit etre identique
   - Chaque mot doit etre present et orthographie identiquement
   - Les references legales (Art. xxx CO) doivent etre exactes
   - Les noms propres et acronymes doivent etre inchanges
   Liste TOUTE difference trouvee, meme mineure.

2. INTEGRITE DU LAYOUT (score /10)
   - La structure colonnes/lignes est-elle preservee?
   - La hierarchie titre → donnees → source est-elle respectee?
   - Les alignements sont-ils coherents?

3. LISIBILITE (score /10)
   - Le texte est-il net et lisible (pas de flou)?
   - Le contraste texte/fond est-il suffisant?
   - Les chiffres sont-ils lisibles a taille normale?
   - Y a-t-il des artefacts visuels genants?

Textes attendus dans l'exhibit (pour reference):
${cleanExpected.join('\n')}

Reponds UNIQUEMENT en JSON:
{
  "verdict": "PASS" | "FAIL",
  "text_integrity": {
    "score": 0-10,
    "differences": ["description de chaque difference trouvee"]
  },
  "layout_integrity": {
    "score": 0-10,
    "issues": ["description de chaque probleme"]
  },
  "legibility": {
    "score": 0-10,
    "issues": ["description de chaque probleme"]
  },
  "recommendation": "use_gemini" | "use_source" | "retry_gemini",
  "reasoning": "Explication courte du verdict"
}

REGLES DE VERDICT:
- Si UN SEUL chiffre est different → FAIL + use_source
- Si UN SEUL mot est manquant → FAIL + retry_gemini
- Si la source legale est alteree → FAIL + use_source
- Si lisibilite < 7 → FAIL + retry_gemini
- Si layout < 6 → FAIL + use_source
- En cas de doute → FAIL (la source est toujours preferable)`;

  const user = [
    { type: 'text', text: 'IMAGE 1 (source de verite — SVG rasterise):' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: sourceB64 } },
    { type: 'text', text: 'IMAGE 2 (version stylisee — Gemini):' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: geminiB64 } },
  ];

  try {
    const resp = await callClaudeWithRetry(apiKey, system, user, 1500);
    const text = extractClaudeText(resp).replace(/```json\s?|```/g, '').trim();
    const result = JSON.parse(text);

    const verdict = result.verdict || 'FAIL';
    const recommendation = result.recommendation || 'use_source';

    logger.info(`Agent 3: verdict=${verdict} recommendation=${recommendation} text=${result.text_integrity?.score}/10 layout=${result.layout_integrity?.score}/10 lisibilite=${result.legibility?.score}/10`);

    if (result.text_integrity?.differences?.length > 0) {
      logger.warn(`Agent 3: differences detectees: ${result.text_integrity.differences.join('; ')}`);
    }

    return { verdict, recommendation, details: result };
  } catch (e) {
    logger.warn(`Agent 3 echoue: ${e.message} — fallback source`);
    return { verdict: 'FAIL', recommendation: 'use_source', details: { error: e.message } };
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN PIPELINE — Process a single exhibit end-to-end
// ═══════════════════════════════════════════════════════════════

/**
 * Process a single exhibit: data extraction → SVG → PNG → Gemini → verify → output.
 *
 * @param {string} apiKey - Anthropic API key
 * @param {string} articleText - Full article text
 * @param {object} exhibitBrief - Brief from Agent 0 (type, title, data_context)
 * @param {string} keyword - Article keyword
 * @param {string} site - Site domain
 * @param {string} slug - Article slug
 * @param {boolean} dryRun - If true, generate SVG only (no Gemini, no upload)
 * @returns {object} { filename, altText, verified, usedGemini, svgPath, pngPath }
 */
async function processExhibit(apiKey, articleText, exhibitBrief, keyword, site, slug, dryRun) {
  ensureDir(EXHIBITS_DIR);

  const exhibitStyle = getSiteExhibitStyle(site);
  const exhibitNum = exhibitBrief.exhibit_number || 1;
  const baseFilename = `exhibit-${sanitizeSlug(slug)}-${exhibitNum}`;

  // ── Pipeline 2: Extract structured data ──
  const exhibitData = await extractExhibitData(apiKey, articleText, exhibitBrief, keyword);
  if (!exhibitData) {
    logger.warn(`Exhibit ${exhibitNum}: extraction donnees echouee — skip`);
    return null;
  }

  // Save data JSON for debugging
  writeJSONAtomic(path.join(EXHIBITS_DIR, `${baseFilename}-data.json`), exhibitData);

  // ── Pipeline 3a: Generate SVG ──
  const svg = await renderExhibitSVG(apiKey, exhibitData, exhibitNum, exhibitStyle);
  if (!svg) {
    logger.warn(`Exhibit ${exhibitNum}: generation SVG echouee — skip`);
    return null;
  }

  // Save SVG
  const svgPath = path.join(EXHIBITS_DIR, `${baseFilename}.svg`);
  fs.writeFileSync(svgPath, svg, 'utf-8');

  // ── Rasterize SVG → PNG ──
  const sourcePng = await rasterizeSVG(svg);
  if (!sourcePng) {
    logger.warn(`Exhibit ${exhibitNum}: rasterisation echouee — skip`);
    return null;
  }

  // Save source PNG (always — this is the fallback)
  const sourcePngPath = path.join(EXHIBITS_DIR, `${baseFilename}-source.png`);
  fs.writeFileSync(sourcePngPath, sourcePng);

  if (dryRun) {
    logger.info(`Exhibit ${exhibitNum}: dry-run — SVG + PNG source generes`);
    return {
      filename: `${baseFilename}-source.png`, altText: exhibitData.title,
      verified: false, usedGemini: false, svgPath, pngPath: sourcePngPath,
    };
  }

  // ── Pipeline 3b: Gemini style transfer (with retry loop + Agent 3 verification) ──
  let finalPng = sourcePng;
  let usedGemini = false;
  let verified = false;

  for (let attempt = 1; attempt <= MAX_GEMINI_RETRIES; attempt++) {
    logger.info(`Exhibit ${exhibitNum}: Gemini tentative ${attempt}/${MAX_GEMINI_RETRIES}`);

    const geminiPng = await geminiStyleTransferWithRetry(sourcePng, exhibitStyle);
    if (!geminiPng) {
      logger.warn(`Exhibit ${exhibitNum}: Gemini a echoue — fallback SVG source`);
      break;
    }

    // ── Agent 3: Verify integrity ──
    const verification = await verifyExhibitIntegrity(apiKey, sourcePng, geminiPng, exhibitData);

    if (verification.verdict === 'PASS') {
      finalPng = geminiPng;
      usedGemini = true;
      verified = true;
      logger.info(`Exhibit ${exhibitNum}: Gemini PASS — utilisation de la version stylisee`);
      break;
    }

    if (verification.recommendation === 'use_source') {
      logger.info(`Exhibit ${exhibitNum}: Agent 3 recommande source — arret des retries`);
      verified = true; // verified as "source is better"
      break;
    }

    // recommendation === 'retry_gemini' — continue loop
    if (attempt < MAX_GEMINI_RETRIES) {
      logger.info(`Exhibit ${exhibitNum}: Agent 3 recommande retry (${attempt}/${MAX_GEMINI_RETRIES})`);
    } else {
      logger.info(`Exhibit ${exhibitNum}: max retries atteint — fallback SVG source`);
      verified = true;
    }
  }

  // Save final PNG
  const finalPngPath = path.join(EXHIBITS_DIR, `${baseFilename}.png`);
  fs.writeFileSync(finalPngPath, finalPng);

  logger.info(`Exhibit ${exhibitNum}: termine — ${usedGemini ? 'Gemini' : 'SVG source'} (${(finalPng.length / 1024).toFixed(0)}KB)`);

  return {
    filename: `${baseFilename}.png`,
    altText: exhibitData.title,
    verified,
    usedGemini,
    svgPath,
    pngPath: finalPngPath,
    exhibitData,
  };
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API — Called from seo-images.js or seo-publish-article.js
// ═══════════════════════════════════════════════════════════════

/**
 * Generate exhibits for an article.
 *
 * @param {string} articleText - Full article text (sections joined)
 * @param {object} siteContext - Site context from config
 * @param {string} keyword - Article keyword
 * @param {string} site - Site domain
 * @param {string} slug - Article slug
 * @param {boolean} dryRun - Dry run mode
 * @returns {Promise<Array<{filename, altText, verified, usedGemini}>>}
 */
async function generateExhibits(articleText, siteContext, keyword, site, slug, dryRun) {
  const apiKey = requireAnthropicKey();

  // Agent 0: Plan exhibits
  const briefs = await planExhibits(apiKey, articleText, siteContext, keyword);
  if (briefs.length === 0) {
    logger.info('Aucun exhibit pertinent identifie pour cet article');
    return [];
  }

  // Process each exhibit
  const results = [];
  for (const brief of briefs) {
    try {
      const result = await processExhibit(apiKey, articleText, brief, keyword, site, slug, dryRun);
      if (result) results.push(result);
    } catch (e) {
      logger.warn(`Exhibit ${brief.exhibit_number} echoue: ${e.message}`);
    }
  }

  logger.info(`Exhibits: ${results.length}/${briefs.length} generes (${results.filter((r) => r.usedGemini).length} avec Gemini)`);
  return results;
}

// ═══════════════════════════════════════════════════════════════
// CLI (standalone execution)
// ═══════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (args.includes('--test')) {
    // Test mode: generate a sample exhibit
    const testArticle = `Création d'une SA à Genève: guide complet.
La SA nécessite un capital minimum de CHF 100'000, dont 50% (CHF 50'000) doit être libéré à la constitution.
La Sàrl nécessite CHF 20'000, libéré à 100%.
La SA permet la cotation en bourse, pas la Sàrl.
Le transfert d'actions SA est libre, celui de parts Sàrl nécessite un acte notarié.
Coût notaire SA: CHF 2'500 à 4'000. Coût notaire Sàrl: CHF 1'500 à 2'500.
Source: Art. 620 ss CO (SA) et Art. 772 ss CO (Sàrl) — fedlex.admin.ch`;

    const results = await generateExhibits(testArticle,
      { secteur: 'Fiduciaire / comptabilite', ton: 'Technique, direct' },
      'création SA Genève', 'fiduciaire-genevoise.ch', 'creation-sa-geneve', dryRun);

    console.log(`\n${results.length} exhibit(s) genere(s)`);
    for (const r of results) {
      console.log(`  ${r.filename} — Gemini: ${r.usedGemini} — Verifie: ${r.verified}`);
    }
    return;
  }

  console.log('Usage:');
  console.log('  node seo-exhibits.js --test              Genere un exhibit de test');
  console.log('  node seo-exhibits.js --test --dry-run    Dry-run (SVG seulement)');
  process.exit(1);
}

// Only run main when executed directly
if (require.main === module) {
  main().catch((err) => { console.error(`\n! Fatal: ${err.message}`); process.exit(1); });
}

module.exports = { generateExhibits, planExhibits };
