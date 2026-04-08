#!/usr/bin/env node
/**
 * seo-weekly-report.js v3
 * CTR monitoring par article, content decay detection,
 * GEO visibility recurrent, Claude retry.
 * Jarvis One — Groupe Genevoise
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  PATHS, logger, validateEnv, ensureDir,
  loadSecret, getSiteList, getSiteLabels,
  rateLimitedSemrushGet, trackUnits, printUnitsSummary,
  callClaudeWithRetry, extractClaudeText,
  httpRequest, esc, readJSONSafe, writeJSONAtomic,
  loadTrackedArticles, updateArticleField, loadLatestGapAnalysis,
  sendEmail, EMAIL_RECIPIENTS,
} = require('./seo-shared');

const SITES = getSiteList();
const SITE_LABELS = getSiteLabels();

// ─── Date Helpers ────────────────────────────────────────────

function getWeekDates(weekStr) {
  let monday;
  if (weekStr) {
    if (!/^\d{4}-W\d{1,2}$/.test(weekStr)) { console.error(`Format invalide: "${weekStr}". Attendu: YYYY-WNN`); process.exit(1); }
    const [year, week] = weekStr.split('-W').map(Number);
    if (week < 1 || week > 53) { console.error(`Semaine invalide: ${week}`); process.exit(1); }
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dow = jan4.getUTCDay() || 7;
    monday = new Date(jan4.getTime() + ((1 - dow + (week - 1) * 7) * 86400000));
  } else {
    monday = new Date(); monday.setDate(monday.getDate() - (monday.getDay() || 7) + 1); monday.setHours(0, 0, 0, 0);
  }
  return { monday, sunday: new Date(monday.getTime() + 6 * 86400000), prevMonday: new Date(monday.getTime() - 7 * 86400000), prevSunday: new Date(monday.getTime() - 86400000), weekStr: weekStr || getISOWeek(monday), year: monday.getFullYear() };
}
// getISOWeek loaded from seo-shared.js
function formatDate(d) { return d.toISOString().split('T')[0]; }

// HTTP loaded from seo-shared.js

// Tracking loaded from seo-shared.js: loadTrackedArticles, updateArticleField

// ─── Position Check (with domain cache) ──────────────────────

async function checkArticlePositions(semrushKey, articles, today) {
  console.log('\n> Tracking positions');
  const todayStr = formatDate(today);
  const results = [];
  const cache = {};

  for (const art of articles) {
    if (!art.keyword || !art.site) continue;
    let checkpoint = null, field = null;
    if (art.j30_date && todayStr >= art.j30_date.split('T')[0] && !art.position_j30) { checkpoint = 'J+30'; field = 'position_j30'; }
    else if (art.j60_date && todayStr >= art.j60_date.split('T')[0] && !art.position_j60) { checkpoint = 'J+60'; field = 'position_j60'; }
    else if (art.j90_date && todayStr >= art.j90_date.split('T')[0] && !art.position_j90) { checkpoint = 'J+90'; field = 'position_j90'; }
    if (!checkpoint) continue;

    try {
      if (!cache[art.site]) {
        const resp = await rateLimitedSemrushGet(`https://api.semrush.com/?type=domain_organic&key=${semrushKey}&domain=${art.site}&database=ch&export_columns=Ph,Po&display_limit=200`);
        trackUnits('domain_organic', 10);
        const map = {};
        for (const line of resp.trim().split('\n').slice(1)) { const p = line.split(';'); const kw = (p[0] || '').trim().toLowerCase(); if (kw) map[kw] = parseInt(p[1], 10) || null; }
        cache[art.site] = map;
      }
      const position = cache[art.site][art.keyword.toLowerCase()] || null;
      if (position !== null) {
        updateArticleField(art.id, field, position);
        results.push({ site: art.site, keyword: art.keyword, checkpoint, position, status: position <= 10 ? 'ok' : position <= 20 ? 'mid' : 'low', slug: art.slug });
        console.log(`  ${position <= 10 ? '+' : position <= 20 ? '~' : '-'} ${art.keyword}: pos ${position} (${checkpoint})`);
      }
    } catch (e) { logger.debug("catch silencieux", { error: e.message }); }
  }
  return results;
}

// ─── CTR Monitoring ──────────────────────────────────────────
// Compare CTR reel vs CTR attendu pour la position

const EXPECTED_CTR = { 1: 0.28, 2: 0.15, 3: 0.11, 4: 0.08, 5: 0.06, 6: 0.05, 7: 0.04, 8: 0.03, 9: 0.03, 10: 0.02 };

function analyzeCTR(trackedArticles, gscDataBySite) {
  console.log('\n> CTR Monitoring');
  const alerts = [];

  for (const art of trackedArticles) {
    if (!art.site || !art.keyword) continue;
    const gsc = gscDataBySite[art.site];
    if (!gsc || !gsc.current || !gsc.current.pages) continue;

    // Find the page matching this article's slug
    const matchingPage = gsc.current.pages.find((p) => art.slug && p.url.includes(art.slug));
    if (!matchingPage || matchingPage.impressions < 50) continue; // Need enough data

    const pos = Math.round(matchingPage.position);
    const expectedCtr = EXPECTED_CTR[pos] || (pos <= 20 ? 0.01 : 0);
    if (expectedCtr === 0) continue;

    const actualCtr = matchingPage.ctr;
    const ratio = actualCtr / expectedCtr;

    if (ratio < 0.5) {
      alerts.push({
        keyword: art.keyword, site: art.site, slug: art.slug,
        position: matchingPage.position, actualCtr: Math.round(actualCtr * 10000) / 100,
        expectedCtr: Math.round(expectedCtr * 10000) / 100, ratio: Math.round(ratio * 100) / 100,
        action: 'Ameliorer title/meta description',
      });
      console.log(`  ! ${art.keyword} (pos ${pos}): CTR ${(actualCtr * 100).toFixed(1)}% vs attendu ${(expectedCtr * 100).toFixed(1)}% -> ameliorer title/meta`);
    }
  }
  return alerts;
}

// ─── Content Decay Detection ─────────────────────────────────

function detectContentDecay(trackedArticles, semrushPositions) {
  console.log('\n> Content Decay Detection');
  const decayed = [];

  for (const art of trackedArticles) {
    if (!art.site || !art.keyword) continue;
    // Articles de 6+ mois
    const pubDate = art.published_at || art.publishedAt;
    if (!pubDate) continue;
    const publishedAt = new Date(pubDate);
    if (isNaN(publishedAt.getTime())) continue;
    const monthsOld = (Date.now() - publishedAt.getTime()) / (30 * 24 * 3600 * 1000);
    if (monthsOld < 6) continue;

    // Trouver la position actuelle via Semrush
    const positions = semrushPositions[art.site] || [];
    const current = positions.find((p) => p.keyword.toLowerCase() === art.keyword.toLowerCase());
    const currentPos = current ? current.position : null;

    // Comparer avec le meilleur historique
    const bestHistorical = Math.min(
      art.position_j30 || 999, art.position_j60 || 999, art.position_j90 || 999
    );

    if (currentPos && bestHistorical < 999 && currentPos > bestHistorical + 10) {
      decayed.push({
        keyword: art.keyword, site: art.site, slug: art.slug,
        bestPosition: bestHistorical, currentPosition: currentPos,
        positionsLost: currentPos - bestHistorical,
        monthsOld: Math.round(monthsOld),
        action: 'Content refresh recommande',
      });
      console.log(`  ! ${art.keyword}: pos ${bestHistorical} -> ${currentPos} (-${currentPos - bestHistorical}, ${Math.round(monthsOld)} mois)`);
    }
  }
  return decayed;
}

// ─── GEO Visibility Recurring Check ──────────────────────────

async function recheckGEOVisibility(apiKey, trackedArticles) {
  console.log('\n> GEO Visibility (recheck)');
  const results = [];
  // Check max 5 articles per run to limit API calls
  const toCheck = trackedArticles.filter((a) => a.keyword && a.site).slice(0, 5);

  for (const art of toCheck) {
    try {
      const resp = await callClaudeWithRetry(apiKey, 'Analyste GEO. JSON: { "visibility": "cited|partial|absent", "confidence": 0-10 }',
        `"${art.keyword}" sur ${art.site}: cite par Google AI Overview / Perplexity ?`, 200);
      const r = JSON.parse(extractClaudeText(resp).replace(/```json\s?|```/g, '').trim());
      const vis = r.visibility || 'unknown';
      updateArticleField(art.id, 'geo_visibility', vis);
      results.push({ keyword: art.keyword, site: art.site, visibility: vis, confidence: r.confidence || 0 });
      console.log(`  ${vis === 'cited' ? '+' : vis === 'partial' ? '~' : '-'} ${art.keyword}: ${vis}`);
    } catch (e) { logger.debug("catch silencieux", { error: e.message }); }
  }
  return results;
}

// ─── Google OAuth + GSC ──────────────────────────────────────

async function getGoogleToken(oauth) {
  const r = await httpRequest('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: oauth.web.client_id, client_secret: oauth.web.client_secret, refresh_token: oauth.web.refresh_token, grant_type: 'refresh_token' }).toString() });
  if (!r.access_token) throw new Error('Google token failed');
  return r.access_token;
}

async function fetchGSC(token, site, start, end) {
  try {
    const r = await httpRequest(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent('sc-domain:' + site)}/searchAnalytics/query`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ startDate: formatDate(start), endDate: formatDate(end), dimensions: ['page', 'query'], rowLimit: 100 }) });
    return r.rows || [];
  } catch (e) { logger.warn(`GSC ${site}: ${e.message}`); return []; }
}

function aggregateGSC(rows) {
  if (!rows.length) return { impressions: 0, clicks: 0, ctr: 0, position: 0, pages: [] };
  let imp = 0, clk = 0, posW = 0;
  const pm = {};
  for (const r of rows) {
    const i = r.impressions || 0, c = r.clicks || 0, p = r.position || 0;
    imp += i; clk += c; if (i > 0) posW += p * i;
    const pg = r.keys ? r.keys[0] : '';
    if (!pm[pg]) pm[pg] = { imp: 0, clk: 0, posS: 0, posW: 0 };
    pm[pg].imp += i; pm[pg].clk += c; if (i > 0) { pm[pg].posS += p * i; pm[pg].posW += i; }
  }
  const pages = Object.entries(pm).map(([url, d]) => ({ url, title: url.split('/').pop() || url, impressions: d.imp, clicks: d.clk, ctr: d.imp > 0 ? d.clk / d.imp : 0, position: d.posW > 0 ? Math.round(d.posS / d.posW * 10) / 10 : 0 })).sort((a, b) => b.clicks - a.clicks).slice(0, 10);
  return { impressions: imp, clicks: clk, ctr: Math.round(imp > 0 ? clk / imp * 10000 : 0) / 100, position: Math.round(imp > 0 ? posW / imp * 10 : 0) / 10, pages };
}

// ─── Semrush ─────────────────────────────────────────────────

async function getSemrushPositions(apiKey, domain) {
  try {
    const resp = await rateLimitedSemrushGet(`https://api.semrush.com/?type=domain_organic&key=${apiKey}&domain=${domain}&database=ch&export_columns=Ph,Po,Nq&display_limit=50`);
    const lines = resp.trim().split('\n');
    if (lines.length < 2) return [];
    const results = lines.slice(1).map((l) => { const p = l.split(';'); return { keyword: (p[0] || '').trim(), position: parseInt(p[1], 10) || 0, volume: parseInt(p[2], 10) || 0 }; }).filter((r) => r.keyword);
    trackUnits('domain_organic', results.length);
    return results;
  } catch (e) { logger.debug('Semrush positions indisponibles', { error: e.message }); return []; }
}

// Gap analysis and esc loaded from seo-shared.js

function generateHTML(data) {
  const { weekStr, year, period, sites, gapAnalysis, articleTracking, ctrAlerts, contentDecay, geoRecheck } = data;
  const wn = weekStr.split('W')[1];

  function kpi(label, value, evo) {
    const e = isFinite(evo) ? evo : 0;
    const arrow = e > 0 ? '&uarr;' : e < 0 ? '&darr;' : '&rarr;';
    const color = e > 0 ? '#27ae60' : e < 0 ? '#e74c3c' : '#95a5a6';
    return `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-evo" style="color:${color}">${e !== 0 ? `${arrow} ${Math.abs(e).toFixed(1)}%` : '&rarr; stable'}</div></div>`;
  }
  function dot(p) { return p <= 3 ? '&#x1F7E2;' : p <= 10 ? '&#x1F7E1;' : '&#x1F534;'; }

  let tI = 0, tC = 0, tPI = 0, tPC = 0, tPos = 0, tPPos = 0, sc = 0;
  for (const s of Object.values(sites)) { tI += s.current.impressions; tC += s.current.clicks; tPI += s.previous.impressions; tPC += s.previous.clicks; tPos += s.current.position; tPPos += s.previous.position; sc++; }
  const avgP = sc > 0 ? tPos / sc : 0, avgPP = sc > 0 ? tPPos / sc : 0;
  const ctr = tI > 0 ? tC / tI * 100 : 0, pCtr = tPI > 0 ? tPC / tPI * 100 : 0;

  let siteSections = '';
  for (const [domain, sd] of Object.entries(sites)) {
    const label = SITE_LABELS[domain] || domain;
    const pages = sd.current.pages || [];
    let rows = pages.slice(0, 8).map((p) => `<tr><td class="page-title">${esc(p.title)}</td><td>${p.position}</td><td>${(p.ctr * 100).toFixed(1)}%</td><td>${dot(p.position)}</td></tr>`).join('');
    siteSections += `<div class="site-section"><h3>${label} <span class="site-domain">${domain}</span></h3><div class="site-kpis"><span>${sd.current.impressions.toLocaleString()} imp.</span><span>${sd.current.clicks.toLocaleString()} clics</span><span>Pos. ${sd.current.position}</span></div>${pages.length > 0 ? `<table><thead><tr><th>Page</th><th>Pos</th><th>CTR</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="no-data">Pas de donnees</p>'}</div>`;
  }

  // Tracking section
  let trackingSection = '';
  if (articleTracking && articleTracking.length > 0) {
    trackingSection = `<h2>Suivi Articles</h2><table><thead><tr><th>Keyword</th><th>Site</th><th>Check</th><th>Pos</th><th>SERP</th></tr></thead><tbody>${articleTracking.map((t) => `<tr><td>${esc(t.keyword)}</td><td>${esc(t.site)}</td><td>${t.checkpoint}</td><td>${t.position}</td><td>${t.status === 'ok' ? '&#x1F7E2;' : t.status === 'mid' ? '&#x1F7E1;' : '&#x1F534;'}</td></tr>`).join('')}</tbody></table>`;
  }

  // CTR Alerts
  let ctrSection = '';
  if (ctrAlerts && ctrAlerts.length > 0) {
    ctrSection = `<h2>Alertes CTR</h2><table><thead><tr><th>Keyword</th><th>Pos</th><th>CTR reel</th><th>CTR attendu</th><th>Action</th></tr></thead><tbody>${ctrAlerts.map((a) => `<tr><td>${esc(a.keyword)}</td><td>${a.position}</td><td>${a.actualCtr}%</td><td>${a.expectedCtr}%</td><td>${a.action}</td></tr>`).join('')}</tbody></table>`;
  }

  // Content Decay
  let decaySection = '';
  if (contentDecay && contentDecay.length > 0) {
    decaySection = `<h2>Content Decay</h2><table><thead><tr><th>Keyword</th><th>Best</th><th>Actuel</th><th>Perdu</th><th>Age</th></tr></thead><tbody>${contentDecay.map((d) => `<tr><td>${esc(d.keyword)}</td><td>${d.bestPosition}</td><td>${d.currentPosition}</td><td>-${d.positionsLost}</td><td>${d.monthsOld}m</td></tr>`).join('')}</tbody></table>`;
  }

  // GEO Recheck
  let geoSection = '';
  if (geoRecheck && geoRecheck.length > 0) {
    geoSection = `<h2>GEO Visibility</h2><table><thead><tr><th>Keyword</th><th>Site</th><th>Visibilite</th></tr></thead><tbody>${geoRecheck.map((g) => `<tr><td>${esc(g.keyword)}</td><td>${esc(g.site)}</td><td>${g.visibility === 'cited' ? '&#x1F7E2; cite' : g.visibility === 'partial' ? '&#x1F7E1; partiel' : '&#x1F534; absent'}</td></tr>`).join('')}</tbody></table>`;
  }

  // Gap top 3
  let gapSection = '';
  if (gapAnalysis) {
    const allOpps = []; for (const [d, sg] of Object.entries(gapAnalysis.sites || {})) { for (const o of (sg.opportunities || []).slice(0, 3)) allOpps.push({ ...o, domain: d }); }
    const top3 = allOpps.sort((a, b) => b.score - a.score).slice(0, 3);
    if (top3.length) gapSection = `<div class="gap-section"><h3>Top 3 Opportunites</h3><table><thead><tr><th>Mot-cle</th><th>Site</th><th>Vol</th><th>Score</th></tr></thead><tbody>${top3.map((o) => `<tr><td><strong>${esc(o.keyword)}</strong></td><td>${esc(o.domain)}</td><td>${o.volume}</td><td>${o.score}</td></tr>`).join('')}</tbody></table></div>`;
  }

  const eI = tPI > 0 ? (tI - tPI) / tPI * 100 : 0, eC = tPC > 0 ? (tC - tPC) / tPC * 100 : 0;
  const eCtr = pCtr > 0 ? (ctr - pCtr) / pCtr * 100 : 0, eP = avgPP > 0 ? (avgPP - avgP) / avgPP * 100 : 0;

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Helvetica Neue',Arial,sans-serif;color:#2c3e50;font-size:13px;line-height:1.5}.header{background:#1a1a2e;color:white;padding:30px 40px;display:flex;justify-content:space-between;align-items:center}.header h1{font-size:22px}.header .period{font-size:13px;opacity:.8}.header .logo{font-size:14px;font-weight:300;letter-spacing:2px;text-transform:uppercase}.content{padding:30px 40px}h2{font-size:16px;color:#1a1a2e;margin:25px 0 15px;padding-bottom:8px;border-bottom:2px solid #e8e8e8}h3{font-size:14px;margin-bottom:10px}.site-domain{font-weight:300;color:#7f8c8d;font-size:12px}.kpi-grid{display:flex;gap:20px;margin-bottom:30px}.kpi-card{flex:1;background:#f8f9fa;border-radius:8px;padding:18px;text-align:center;border:1px solid #e8e8e8}.kpi-label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#7f8c8d;margin-bottom:5px}.kpi-value{font-size:24px;font-weight:700;color:#1a1a2e}.kpi-evo{font-size:12px;margin-top:4px;font-weight:600}.site-section{margin-bottom:25px;padding:20px;background:#fafbfc;border-radius:8px;border:1px solid #eee}.site-kpis{display:flex;gap:20px;margin-bottom:12px;font-size:12px;color:#555}table{width:100%;border-collapse:collapse;font-size:12px}th{background:#1a1a2e;color:white;padding:8px 12px;text-align:left}td{padding:8px 12px;border-bottom:1px solid #eee}tr:nth-child(even){background:#f8f9fa}.page-title{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gap-section{margin-top:25px}.no-data{color:#999;font-style:italic;font-size:12px}.footer{margin-top:40px;padding:25px 40px;background:#f4f4f4;border-top:2px solid #1a1a2e;font-size:11px;color:#7f8c8d}.footer .sig{white-space:pre-line;line-height:1.8}.confidential{margin-top:10px;font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:1px}</style></head><body>
<div class="header"><div><h1>Rapport SEO Hebdomadaire</h1><div class="period">Semaine ${wn}, ${year} &mdash; ${period}</div></div><div class="logo">Groupe Genevoise</div></div>
<div class="content">
<h2>Synthese Executive</h2>
<div class="kpi-grid">${kpi('Impressions', tI.toLocaleString(), eI)}${kpi('Clics', tC.toLocaleString(), eC)}${kpi('CTR', ctr.toFixed(1) + '%', eCtr)}${kpi('Position', avgP.toFixed(1), eP)}</div>
<h2>Business Lines</h2>${siteSections}
${trackingSection}${ctrSection}${decaySection}${geoSection}${gapSection}
</div>
<div class="footer"><div class="sig">Jarvis One | Chief Assistant | A26K Group | jarvis@groupe-genevoise.ch</div><div class="confidential">Confidentiel — Usage interne</div></div>
</body></html>`;
}

function generatePDF(htmlPath, pdfPath) {
  try {
    execFileSync('wkhtmltopdf', [
      '--page-size', 'A4',
      '--margin-top', '15', '--margin-bottom', '15',
      '--margin-left', '15', '--margin-right', '15',
      '--encoding', 'utf-8',
      htmlPath, pdfPath,
    ], { stdio: 'pipe' });
    return true;
  } catch (e) {
    logger.warn('wkhtmltopdf non disponible', { error: e.message });
    return false;
  }
}

function buildEmailSummary(data) {
  const wn = data.weekStr.split('W')[1];
  let tI = 0, tC = 0; for (const s of Object.values(data.sites)) { tI += s.current.impressions; tC += s.current.clicks; }
  const alerts = (data.ctrAlerts || []).length + (data.contentDecay || []).length;
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px"><h2 style="color:#1a1a2e">Rapport SEO S${wn}</h2><p style="color:#555;font-size:14px"><strong>${tI.toLocaleString()}</strong> imp. | <strong>${tC.toLocaleString()}</strong> clics | <strong>${Object.keys(data.sites).length}</strong> sites${alerts > 0 ? ` | <strong style="color:#e74c3c">${alerts} alertes</strong>` : ''}</p><p style="color:#555;font-size:14px">Rapport PDF en piece jointe.</p><hr style="border:none;border-top:1px solid #eee;margin:20px 0"><p style="color:#999;font-size:12px">Jarvis One | A26K Group</p></div>`;
}

async function sendReportEmail(subject, html, pdfPath) {
  const attachments = (pdfPath && fs.existsSync(pdfPath))
    ? [{ filename: path.basename(pdfPath), content: fs.readFileSync(pdfPath).toString('base64') }]
    : undefined;
  return sendEmail(subject, html, attachments);
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('========================================');
  console.log('  SEO Weekly Report v3');
  console.log('========================================');

  const args = process.argv.slice(2);
  const wIdx = args.indexOf('--week');
  let weekParam = null;
  if (wIdx !== -1) { weekParam = args[wIdx + 1]; if (!weekParam || weekParam.startsWith('--')) { console.error('--week requiert une valeur'); process.exit(1); } }
  const dates = getWeekDates(weekParam);
  console.log(`  Semaine: ${dates.weekStr} | ${formatDate(dates.monday)} -> ${formatDate(dates.sunday)}`);

  const googleOAuth = loadSecret('google-oauth');
  const semrush = loadSecret('semrush');
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  let token = null;
  try { token = await getGoogleToken(googleOAuth); console.log('  + Google token'); } catch (e) { console.error(`  ! Google: ${e.message}`); }

  // Collect GSC + Semrush per site
  const sitesData = {};
  const semrushPositions = {};
  for (const domain of SITES) {
    console.log(`\n> ${SITE_LABELS[domain]} (${domain})`);
    let cur = { impressions: 0, clicks: 0, ctr: 0, position: 0, pages: [] };
    let prev = { impressions: 0, clicks: 0, ctr: 0, position: 0, pages: [] };
    if (token) {
      cur = aggregateGSC(await fetchGSC(token, domain, dates.monday, dates.sunday));
      prev = aggregateGSC(await fetchGSC(token, domain, dates.prevMonday, dates.prevSunday));
      console.log(`  + GSC: ${cur.impressions} imp, ${cur.clicks} clics`);
    }
    const sem = await getSemrushPositions(semrush.api_key, domain);
    semrushPositions[domain] = sem;
    console.log(`  + Semrush: ${sem.length} positions`);
    sitesData[domain] = { current: cur, previous: prev, semrush: sem };
  }

  // Article tracking
  const trackedArticles = loadTrackedArticles();
  let articleTracking = [];
  if (trackedArticles.length > 0) {
    articleTracking = await checkArticlePositions(semrush.api_key, trackedArticles, new Date());
  }

  // CTR Monitoring
  const ctrAlerts = analyzeCTR(trackedArticles, sitesData);

  // Content Decay
  const contentDecay = detectContentDecay(trackedArticles, semrushPositions);

  // GEO Visibility recheck
  let geoRecheck = [];
  if (anthropicKey && trackedArticles.length > 0) {
    geoRecheck = await recheckGEOVisibility(anthropicKey, trackedArticles);
  }

  // Gap analysis
  const gap = loadLatestGapAnalysis();

  // Generate report
  console.log('\n> Generation rapport');
  const reportData = { weekStr: dates.weekStr, year: dates.year, period: `${formatDate(dates.monday)} -> ${formatDate(dates.sunday)}`, sites: sitesData, gapAnalysis: gap, articleTracking, ctrAlerts, contentDecay, geoRecheck };
  const htmlContent = generateHTML(reportData);

  ensureDir(PATHS.reports);
  const base = `seo-weekly-${dates.weekStr}`;
  writeJSONAtomic(path.join(PATHS.reports, `${base}.json`), reportData);
  const htmlPath = path.join(PATHS.reports, `${base}.html`);
  fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
  const pdfPath = path.join(PATHS.reports, `${base}.pdf`);
  const hasPdf = generatePDF(htmlPath, pdfPath);

  // Email
  console.log('\n> Email');
  const subject = `Rapport SEO S${dates.weekStr.split('W')[1]}, ${dates.year} | Groupe Genevoise`;
  try {
    await sendReportEmail(subject, buildEmailSummary(reportData), hasPdf ? pdfPath : null);
    console.log(`  + Envoye a ${EMAIL_RECIPIENTS.join(', ')}`);
  } catch (e) { logger.error(`Email: ${e.message}`); }

  console.log('\n========================================');
  console.log(`+ S${dates.weekStr.split('W')[1]} termine`);
  if (articleTracking.length) console.log(`  Positions: ${articleTracking.length} articles`);
  if (ctrAlerts.length) console.log(`  CTR alertes: ${ctrAlerts.length}`);
  if (contentDecay.length) console.log(`  Content decay: ${contentDecay.length}`);
  if (geoRecheck.length) console.log(`  GEO recheck: ${geoRecheck.length}`);
  printUnitsSummary();
  console.log('========================================\n');
}

main().catch((err) => { console.error(`\n! Fatal: ${err.message}`); process.exit(1); });
