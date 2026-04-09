#!/usr/bin/env node
/**
 * seo-gap-analysis.js v3
 * Trending keywords, featured snippets, dynamic competitors,
 * cluster detection, cannibalization, Semrush data validation.
 * Jarvis One — Groupe Genevoise
 */
const fs = require('fs');
const path = require('path');
const {
  PATHS, logger, loadSecret, getSiteConfig, getSiteList, getSiteFallbackCompetitors,
  ensureDir,
  rateLimitedSemrushRequest, rateLimitedSemrushGet, trackUnits, printUnitsSummary, validateSemrushData,
  writeJSONAtomic,
} = require('./seo-shared');

function getIntentMultiplier(co) {
  const v = parseFloat(co) || 0;
  if (v >= 0.8) return { multiplier: 2.0, label: 'transactional' };
  if (v >= 0.5) return { multiplier: 1.5, label: 'commercial' };
  return { multiplier: 1.0, label: 'informational' };
}

// ─── Semrush helpers ─────────────────────────────────────────

async function getOrganicPositions(apiKey, domain) {
  console.log(`  -> Positions: ${domain}`);
  try {
    const rows = await rateLimitedSemrushRequest({ type: 'domain_organic', key: apiKey, domain, database: 'ch', export_columns: 'Ph,Po,Nq,Kd,Co,Ur,Fk', display_limit: 500 });
    trackUnits('domain_organic', rows.length);
    validateSemrushData(domain, rows.length);
    return rows.map((r) => ({
      keyword: r['Keyword'] || r['Ph'] || '',
      position: parseInt(r['Position'] || r['Po'], 10) || 0,
      volume: parseInt(r['Search Volume'] || r['Nq'], 10) || 0,
      difficulty: parseInt(r['Keyword Difficulty'] || r['Kd'], 10) || 0,
      competition: r['Competition'] || r['Co'] || '0',
      url: r['Url'] || r['Ur'] || '',
      featuredSnippet: ((r['Featured Keywords'] || r['Fk'] || '').toLowerCase().includes('featured snippet')),
    })).filter((r) => r.keyword);
  } catch (err) {
    logger.warn(`Semrush ${domain}: ${err.message}`);
    return [];
  }
}

// ─── Dynamic Competitors (Semrush domain_organic_organic) ────

async function findDynamicCompetitors(apiKey, domain, fallbacks) {
  console.log(`  -> Concurrents dynamiques: ${domain}`);
  try {
    const rows = await rateLimitedSemrushRequest({ type: 'domain_organic_organic', key: apiKey, domain, database: 'ch', export_columns: 'Dn,Np,Or', display_limit: 5 });
    trackUnits('domain_organic_organic', rows.length);
    const competitors = rows.map((r) => (r['Domain'] || r['Dn'] || '').trim()).filter((d) => d && d !== domain);
    if (competitors.length >= 2) {
      console.log(`  + Concurrents auto: ${competitors.join(', ')}`);
      return competitors.slice(0, 3);
    }
  } catch (err) { logger.warn(`Concurrents dynamiques: ${err.message}`); }
  console.log(`  + Fallback concurrents: ${fallbacks.join(', ')}`);
  return fallbacks;
}

// ─── Trending Keywords ───────────────────────────────────────

async function enrichWithTrend(apiKey, keyword) {
  try {
    const resp = await rateLimitedSemrushGet(`https://api.semrush.com/?type=phrase_kdi&key=${apiKey}&phrase=${encodeURIComponent(keyword)}&database=ch&export_columns=Ph,Td`);
    trackUnits('phrase_kdi', 1);
    const lines = resp.trim().split('\n');
    if (lines.length >= 2) {
      const trendData = (lines[1].split(';')[1] || '').trim();
      // Td = trend data as comma-separated monthly volumes (12 months)
      if (trendData) {
        const months = trendData.split(',').map((v) => parseInt(v, 10) || 0);
        if (months.length >= 6) {
          const recent3 = months.slice(-3).reduce((a, b) => a + b, 0) / 3;
          const older3 = months.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
          const trendRatio = older3 > 0 ? recent3 / older3 : 1;
          return { trending: trendRatio > 1.3, trendRatio: Math.round(trendRatio * 100) / 100, recentAvg: Math.round(recent3), olderAvg: Math.round(older3) };
        }
      }
    }
  } catch (e) { logger.debug("Trend data indisponible", { error: e.message }); }
  return { trending: false, trendRatio: 1, recentAvg: 0, olderAvg: 0 };
}

// ─── 1. Keyword Gap (intent + trend weighted) ───────────────

function computeKeywordGap(ourKeywords, competitorData) {
  const ourSet = new Set(ourKeywords.map((k) => k.keyword.toLowerCase()));
  const gaps = [];
  for (const comp of competitorData) {
    for (const kw of comp.keywords) {
      if (kw.position < 1 || kw.position > 20 || ourSet.has(kw.keyword.toLowerCase())) continue;
      if (kw.volume < 100 || kw.difficulty > 40) continue;
      const intent = getIntentMultiplier(kw.competition);
      const base = kw.volume / (kw.difficulty + 1);
      gaps.push({ keyword: kw.keyword, volume: kw.volume, difficulty: kw.difficulty, intent: intent.label, baseScore: Math.round(base * 10) / 10, score: Math.round(base * intent.multiplier * 10) / 10, featuredSnippet: kw.featuredSnippet, competitorRanking: { domain: comp.domain, position: kw.position } });
    }
  }
  const deduped = {};
  for (const g of gaps) { const k = g.keyword.toLowerCase(); if (!deduped[k] || deduped[k].score < g.score) deduped[k] = g; }
  return Object.values(deduped).sort((a, b) => b.score - a.score).slice(0, 20);
}

// ─── 2. Featured Snippets Opportunities ─────────────────────

function extractFeaturedSnippetOpportunities(keywordGap, ourKeywords) {
  // Keywords with featured snippets where we don't rank
  const fsGaps = keywordGap.filter((g) => g.featuredSnippet);
  // Keywords where we rank 2-10 and there's a featured snippet (we could capture it)
  const fsCapturable = ourKeywords.filter((k) => k.featuredSnippet && k.position >= 2 && k.position <= 10).map((k) => ({ keyword: k.keyword, position: k.position, volume: k.volume, type: 'capturable' }));
  return { gaps: fsGaps.slice(0, 10), capturable: fsCapturable.slice(0, 10) };
}

// ─── 3. Content Gap par URL ──────────────────────────────────

function computeContentGap(ourKeywords, competitorData) {
  const pages = {};
  for (const comp of competitorData) {
    for (const kw of comp.keywords) {
      if (!kw.url || kw.position > 20) continue;
      const key = `${comp.domain}|${kw.url}`;
      if (!pages[key]) pages[key] = { domain: comp.domain, url: kw.url, keywords: [], totalVolume: 0 };
      pages[key].keywords.push(kw.keyword);
      pages[key].totalVolume += kw.volume;
    }
  }
  const ourSet = new Set(ourKeywords.map((k) => k.keyword.toLowerCase()));
  const results = [];
  for (const page of Object.values(pages)) {
    if (page.keywords.length < 3) continue;
    const uncovered = page.keywords.filter((k) => !ourSet.has(k.toLowerCase()));
    const coverage = 1 - uncovered.length / page.keywords.length;
    if (coverage >= 0.3) continue;
    const slug = page.url.replace(/https?:\/\/[^/]+/, '').replace(/\/$/, '');
    const theme = slug.split('/').pop().replace(/[-_]/g, ' ').replace(/\.\w+$/i, '').trim();
    results.push({ competitorDomain: page.domain, competitorUrl: page.url, theme: theme || slug, totalKeywords: page.keywords.length, uncoveredKeywords: uncovered.length, coveragePercent: Math.round(coverage * 100), totalVolume: page.totalVolume, topUncoveredKeywords: uncovered.slice(0, 5) });
  }
  return results.sort((a, b) => b.totalVolume - a.totalVolume).slice(0, 10);
}

// ─── 4. Cannibalization ─────────────────────────────────────

function checkCannibalization(ourKeywords) {
  const map = {};
  for (const kw of ourKeywords) {
    if (!kw.url || kw.position > 50) continue;
    const k = kw.keyword.toLowerCase();
    if (!map[k]) map[k] = [];
    map[k].push({ url: kw.url, position: kw.position, volume: kw.volume });
  }
  return Object.entries(map).filter(([, urls]) => urls.length > 1).map(([keyword, urls]) => {
    urls.sort((a, b) => a.position - b.position);
    return { keyword, volume: urls[0].volume, pagesCount: urls.length, pages: urls.map((u) => ({ url: u.url, position: u.position })), severity: urls.length >= 3 ? 'high' : 'medium' };
  }).sort((a, b) => b.volume - a.volume).slice(0, 15);
}

// ─── 5. Cluster Detection ───────────────────────────────────

function detectClusters(keywordGap) {
  if (keywordGap.length < 3) return [];
  const kwTokens = keywordGap.map((g) => ({ keyword: g.keyword, score: g.score, volume: g.volume, tokens: g.keyword.toLowerCase().split(/\s+/).filter((w) => w.length > 3) }));
  const tokenFreq = {};
  for (const kw of kwTokens) {
    const seen = new Set();
    for (const t of kw.tokens) { if (seen.has(t)) continue; seen.add(t); if (!tokenFreq[t]) tokenFreq[t] = { count: 0, keywords: [] }; tokenFreq[t].count++; tokenFreq[t].keywords.push(kw.keyword); }
  }
  const assigned = new Set();
  const clusters = [];
  for (const [root, data] of Object.entries(tokenFreq).filter(([, v]) => v.count >= 3).sort((a, b) => b[1].count - a[1].count)) {
    const members = data.keywords.filter((k) => !assigned.has(k.toLowerCase()));
    if (members.length < 3) continue;
    for (const m of members) assigned.add(m.toLowerCase());
    const details = members.map((m) => { const g = keywordGap.find((x) => x.keyword.toLowerCase() === m.toLowerCase()); return { keyword: m, volume: g ? g.volume : 0, score: g ? g.score : 0 }; }).sort((a, b) => b.score - a.score);
    clusters.push({ root, pillarCandidate: details[0].keyword, membersCount: details.length, totalVolume: details.reduce((s, m) => s + m.volume, 0), avgScore: Math.round(details.reduce((s, m) => s + m.score, 0) / details.length * 10) / 10, members: details.slice(0, 8) });
  }
  return clusters.sort((a, b) => b.totalVolume - a.totalVolume).slice(0, 5);
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('========================================');
  console.log('  SEO Gap Analysis v3');
  console.log('========================================');

  const semrush = loadSecret('semrush');
  const apiKey = semrush.api_key;

  const args = process.argv.slice(2);
  const siteIdx = args.indexOf('--site');
  let siteFilter = null;
  if (siteIdx !== -1) {
    siteFilter = args[siteIdx + 1];
    if (!siteFilter || siteFilter.startsWith('--')) { console.error('--site requiert une valeur'); process.exit(1); }
  }

  const allSites = getSiteList();
  if (siteFilter && !allSites.includes(siteFilter)) { console.error(`Site inconnu: ${siteFilter}`); process.exit(1); }

  const sitesToProcess = siteFilter ? [siteFilter] : allSites;
  const report = { date: new Date().toISOString().split('T')[0], generatedAt: new Date().toISOString(), version: 3, sites: {} };

  for (const site of sitesToProcess) {
    const config = getSiteConfig(site);
    const verticale = config ? config.verticale : site;
    const fallbackCompetitors = getSiteFallbackCompetitors(site);
    console.log(`\n> ${site} (${verticale})`);

    // Dynamic competitors
    const competitors = await findDynamicCompetitors(apiKey, site, fallbackCompetitors);

    const ourKeywords = await getOrganicPositions(apiKey, site);
    console.log(`  + ${ourKeywords.length} mots-cles`);

    const competitorData = [];
    for (const comp of competitors) {
      const kws = await getOrganicPositions(apiKey, comp);
      console.log(`  + ${kws.length} mots-cles (${comp})`);
      competitorData.push({ domain: comp, keywords: kws });
    }

    const keywordGap = computeKeywordGap(ourKeywords, competitorData);
    const contentGap = computeContentGap(ourKeywords, competitorData);
    const cannibalization = checkCannibalization(ourKeywords);
    const clusters = detectClusters(keywordGap);
    const featuredSnippets = extractFeaturedSnippetOpportunities(keywordGap, ourKeywords);

    // Enrich top 5 gaps with trend data
    console.log('  -> Analyse tendances (top 5)...');
    for (const gap of keywordGap.slice(0, 5)) {
      const trend = await enrichWithTrend(apiKey, gap.keyword);
      gap.trend = trend;
      if (trend.trending) {
        gap.score = Math.round(gap.score * trend.trendRatio * 10) / 10;
        console.log(`    ^ "${gap.keyword}" trending x${trend.trendRatio} -> score ${gap.score}`);
      }
    }
    // Re-sort after trend adjustment
    keywordGap.sort((a, b) => b.score - a.score);

    console.log(`  + ${keywordGap.length} keyword gaps | ${contentGap.length} content gaps | ${cannibalization.length} cannibalization`);
    console.log(`  + ${clusters.length} clusters | ${featuredSnippets.gaps.length} FS gaps | ${featuredSnippets.capturable.length} FS capturable`);

    report.sites[site] = {
      verticale, competitorsUsed: competitors, totalOurKeywords: ourKeywords.length,
      keywordGap, contentGap, cannibalization, clusters, featuredSnippets,
      opportunities: keywordGap,
    };
  }

  ensureDir(PATHS.reports);
  const fp = path.join(PATHS.reports, `gap-analysis-${report.date}.json`);
  writeJSONAtomic(fp, report);

  console.log(`\n+ Rapport: ${fp}`);
  printUnitsSummary();
  console.log('========================================\n');
}

if (require.main === module) {
  main().catch((err) => { console.error(`\n! Erreur fatale: ${err.message}`); process.exit(1); });
}
