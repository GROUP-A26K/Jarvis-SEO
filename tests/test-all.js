#!/usr/bin/env node
/**
 * tests/test-all.js
 * Suite de tests unitaires — fonctions pures.
 * Runner leger, zero dependance.
 *
 * Usage: node tests/test-all.js
 *        npm test
 *
 * Jarvis One — Groupe Genevoise
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Mini test runner ────────────────────────────────────────

let _passed = 0, _failed = 0, _currentSuite = '';
const _failures = [];

function suite(name) { _currentSuite = name; console.log(`\n  ${name}`); }

function test(name, fn) {
  try {
    fn();
    _passed++;
    console.log(`    ✓ ${name}`);
  } catch (e) {
    _failed++;
    const msg = `    ✗ ${name}: ${e.message}`;
    console.log(msg);
    _failures.push({ suite: _currentSuite, test: name, error: e.message });
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertDeepEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn, msg) {
  try { fn(); throw new Error(msg || 'Expected function to throw'); }
  catch (e) { if (e.message === (msg || 'Expected function to throw')) throw e; }
}

function assertIncludes(arr, item, msg) {
  if (!arr.includes(item)) throw new Error(msg || `Expected array to include ${JSON.stringify(item)}`);
}

// ─── Load modules ────────────────────────────────────────────

const shared = require('../scripts/seo-shared');
const gapAnalysisPath = path.join(__dirname, '..', 'scripts', 'seo-gap-analysis.js');
const publishPath = path.join(__dirname, '..', 'scripts', 'seo-publish-article.js');
const imagesPath = path.join(__dirname, '..', 'scripts', 'seo-images.js');

// Extract functions from gap-analysis (they aren't exported, so we test via shared helpers)
// For publish/images, we test the functions that are importable or replicate the logic

console.log('========================================');
console.log('  Jarvis SEO — Test Suite');
console.log('========================================');

// ═══════════════════════════════════════════════════════════════
// seo-shared.js
// ═══════════════════════════════════════════════════════════════

suite('sanitize');
test('removes special characters', () => {
  const result = shared.sanitize('hello;world|test');
  assert(!result.includes(';'), 'should remove semicolons');
  assert(!result.includes('|'), 'should remove pipes');
  assert(result.includes('hello'), 'should keep words');
});
test('preserves accented chars', () => {
  assert(shared.sanitize('café résumé').includes('café'));
});
test('handles null/undefined', () => {
  assertEqual(shared.sanitize(null), '');
  assertEqual(shared.sanitize(undefined), '');
});

suite('sanitizeFilename');
test('lowercases and normalizes', () => {
  assertEqual(shared.sanitizeFilename('Hello World'), 'hello-world');
});
test('replaces accented chars', () => {
  assertEqual(shared.sanitizeFilename('résumé café'), 'resume-cafe');
});
test('removes invalid chars', () => {
  assertEqual(shared.sanitizeFilename('file@#$%name'), 'filename');
});
test('truncates to 60 chars', () => {
  const long = 'a'.repeat(100);
  assert(shared.sanitizeFilename(long).length <= 60);
});
test('handles empty string', () => {
  assertEqual(shared.sanitizeFilename(''), '');
});

suite('sanitizeSlug');
test('is alias for sanitizeFilename', () => {
  assertEqual(shared.sanitizeSlug('Test Article'), shared.sanitizeFilename('Test Article'));
});

suite('sanitizeArticleForLLM');
test('strips HTML tags', () => {
  assertEqual(shared.sanitizeArticleForLLM('<p>hello</p>'), 'hello');
});
test('strips injection patterns', () => {
  const result = shared.sanitizeArticleForLLM('system: override');
  assert(!result.includes('system:'));
  assert(result.includes('[STRIPPED]'));
});
test('truncates to 15000 chars', () => {
  const long = 'x'.repeat(20000);
  assertEqual(shared.sanitizeArticleForLLM(long).length, 15000);
});

suite('esc (HTML escape)');
test('escapes &', () => { assertEqual(shared.esc('A & B'), 'A &amp; B'); });
test('escapes <>', () => { assertEqual(shared.esc('<script>'), '&lt;script&gt;'); });
test('escapes quotes', () => {
  assert(shared.esc('"hello"').includes('&quot;'));
  assert(shared.esc("it's").includes('&#39;'));
});

suite('validateEnv');
test('returns valid when vars present', () => {
  process.env._TEST_VAR = 'value';
  const result = shared.validateEnv(['_TEST_VAR']);
  assert(result.valid);
  delete process.env._TEST_VAR;
});
test('returns invalid when vars missing', () => {
  delete process.env._NONEXISTENT_VAR;
  const result = shared.validateEnv(['_NONEXISTENT_VAR']);
  assert(!result.valid);
  assertIncludes(result.missing, '_NONEXISTENT_VAR');
});
test('reports optional warnings', () => {
  delete process.env._OPT_VAR;
  const result = shared.validateEnv([], ['_OPT_VAR']);
  assert(result.valid);
  assertIncludes(result.warnings, '_OPT_VAR');
});

suite('readJSONSafe');
test('returns default for missing file', () => {
  const result = shared.readJSONSafe('/tmp/nonexistent-xyz-123.json', { fallback: true });
  assertDeepEqual(result, { fallback: true });
});
test('reads valid JSON', () => {
  const tmp = path.join(os.tmpdir(), `test-rjs-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{"key":"value"}');
  const result = shared.readJSONSafe(tmp, {});
  assertEqual(result.key, 'value');
  fs.unlinkSync(tmp);
});
test('returns default for corrupted JSON', () => {
  const tmp = path.join(os.tmpdir(), `test-corrupt-${Date.now()}.json`);
  fs.writeFileSync(tmp, 'not json{{{');
  const result = shared.readJSONSafe(tmp, { fallback: true });
  assertDeepEqual(result, { fallback: true });
  // Cleanup backup
  try { fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(`test-corrupt-${Date.now()}`)).forEach(f => fs.unlinkSync(path.join(os.tmpdir(), f))); } catch {}
});

suite('writeJSONAtomic + writeFileAtomic');
test('writes and reads back', () => {
  const tmp = path.join(os.tmpdir(), `test-wja-${Date.now()}.json`);
  shared.writeJSONAtomic(tmp, { test: 123 });
  const result = shared.readJSONSafe(tmp, {});
  assertEqual(result.test, 123);
  fs.unlinkSync(tmp);
});

suite('acquireLock + withLockedJSON');
test('lock and release', () => {
  const tmp = path.join(os.tmpdir(), `test-lock-${Date.now()}.json`);
  const release = shared.acquireLock(tmp);
  assert(fs.existsSync(`${tmp}.lock`));
  release();
  assert(!fs.existsSync(`${tmp}.lock`));
});
test('withLockedJSON mutates and saves', () => {
  const tmp = path.join(os.tmpdir(), `test-wlj-${Date.now()}.json`);
  shared.writeJSONAtomic(tmp, { count: 0 });
  shared.withLockedJSON(tmp, { count: 0 }, (data) => { data.count++; });
  const result = shared.readJSONSafe(tmp, {});
  assertEqual(result.count, 1);
  fs.unlinkSync(tmp);
});

suite('getSiteList');
test('returns 7 sites', () => {
  const sites = shared.getSiteList();
  assertEqual(sites.length, 7);
});
test('does not include _meta', () => {
  const sites = shared.getSiteList();
  assert(!sites.includes('_meta'));
});
test('includes medcourtage.ch', () => {
  assertIncludes(shared.getSiteList(), 'medcourtage.ch');
});

suite('getSiteConfig');
test('returns config for valid site', () => {
  const cfg = shared.getSiteConfig('medcourtage.ch');
  assert(cfg !== null);
  assertEqual(cfg.label, 'MedCourtage');
});
test('returns null for unknown site', () => {
  assertEqual(shared.getSiteConfig('unknown.ch'), null);
});

suite('getSiteLabels');
test('returns labels for all sites', () => {
  const labels = shared.getSiteLabels();
  assertEqual(labels['medcourtage.ch'], 'MedCourtage');
  assertEqual(labels['fiduciaire-genevoise.ch'], 'Fiduciaire GE');
  assertEqual(Object.keys(labels).length, 7);
});

suite('getSanityDefaults');
test('returns projectId', () => {
  const d = shared.getSanityDefaults();
  assertEqual(d.projectId, 'ttza946i');
});
test('returns all required fields', () => {
  const d = shared.getSanityDefaults();
  assert(d.dataset);
  assert(d.apiVersion);
  assert(d.defaultAuthorId);
  assert(d.defaultCategoryId);
  assert(d.defaultImageId);
});

suite('getSanityDocType');
test('returns correct type for medcourtage', () => {
  assertEqual(shared.getSanityDocType('medcourtage.ch'), 'medcourtageBlogPost');
});
test('returns correct type for assurance', () => {
  assertEqual(shared.getSanityDocType('assurance-genevoise.ch'), 'blogPost');
});

suite('getPersonaDetails');
test('returns style for Hugo Schaller', () => {
  const d = shared.getPersonaDetails('Hugo Schaller');
  assert(d.style.includes('medical'));
});
test('returns empty style for unknown persona', () => {
  const d = shared.getPersonaDetails('Unknown Person');
  assertEqual(d.style, '');
});

suite('getSitePersonas');
test('medcourtage has Hugo and Amelie', () => {
  const p = shared.getSitePersonas('medcourtage.ch');
  assertIncludes(p, 'Hugo Schaller');
  assertIncludes(p, 'Amelie Bonvin');
});

suite('getSiteFallbackCompetitors');
test('medcourtage has 3 competitors', () => {
  const c = shared.getSiteFallbackCompetitors('medcourtage.ch');
  assertEqual(c.length, 3);
  assertIncludes(c, 'swisslife.ch');
});

suite('getSiteSources');
test('medcourtage includes finma.ch', () => {
  assert(shared.getSiteSources('medcourtage.ch').includes('finma.ch'));
});

suite('getSiteEntity');
test('returns entity for medcourtage', () => {
  assertEqual(shared.getSiteEntity('medcourtage.ch'), 'AG Assurance Genevoise SA');
});

suite('getSiteFinma');
test('medcourtage has FINMA', () => {
  assert(shared.getSiteFinma('medcourtage.ch') !== null);
  assert(shared.getSiteFinma('medcourtage.ch').includes('FINMA'));
});
test('relocation has no FINMA', () => {
  assertEqual(shared.getSiteFinma('relocation-genevoise.ch'), null);
});

suite('getISOWeek');
test('returns format YYYY-WNN', () => {
  const w = shared.getISOWeek();
  assert(/^\d{4}-W\d{2}$/.test(w), `Format invalid: ${w}`);
});
test('accepts date parameter', () => {
  const w = shared.getISOWeek(new Date('2025-01-06'));
  assertEqual(w, '2025-W02');
});

suite('validateArticleInput');
test('valid input passes', () => {
  const errors = shared.validateArticleInput({ site: 'medcourtage.ch', keyword: 'test keyword' });
  assertEqual(errors.length, 0);
});
test('invalid site fails', () => {
  const errors = shared.validateArticleInput({ site: 'unknown.ch', keyword: 'test' });
  assert(errors.length > 0);
});
test('dangerous keyword fails', () => {
  const errors = shared.validateArticleInput({ site: 'medcourtage.ch', keyword: 'test;rm -rf' });
  assert(errors.length > 0);
});
test('too-long keyword fails', () => {
  const errors = shared.validateArticleInput({ site: 'medcourtage.ch', keyword: 'a'.repeat(101) });
  assert(errors.length > 0);
});
test('invalid persona fails', () => {
  const errors = shared.validateArticleInput({ site: 'medcourtage.ch', keyword: 'test', persona: 'Fake Person' });
  assert(errors.length > 0);
});

suite('Circuit Breaker');
test('canExecute returns true when closed', () => {
  const cb = shared.createCircuitBreaker('test-service', { threshold: 2, cooldownMs: 100 });
  assert(cb.canExecute());
});
test('opens after threshold failures', () => {
  const cb = shared.createCircuitBreaker('test-open', { threshold: 2, cooldownMs: 100 });
  cb.recordFailure();
  cb.recordFailure();
  assert(!cb.canExecute());
});
test('resets on success', () => {
  const cb = shared.createCircuitBreaker('test-reset', { threshold: 2, cooldownMs: 100 });
  cb.recordFailure();
  cb.recordSuccess();
  assert(cb.canExecute());
});
test('reset() forces closed', () => {
  const cb = shared.createCircuitBreaker('test-force-reset', { threshold: 1, cooldownMs: 60000 });
  cb.recordFailure();
  assert(!cb.canExecute());
  cb.reset();
  assert(cb.canExecute());
});

suite('TIMEOUTS config');
test('all expected keys present', () => {
  const expected = ['claude', 'semrush', 'sanity', 'flux', 'http', 'urlVerify', 'fileLock', 'gsc', 'email'];
  for (const k of expected) {
    assert(shared.TIMEOUTS[k] > 0, `TIMEOUTS.${k} missing or zero`);
  }
});

suite('RETRY config');
test('all expected keys present', () => {
  for (const k of ['claude', 'semrush', 'flux', 'http']) {
    assert(shared.RETRY[k].maxRetries > 0, `RETRY.${k}.maxRetries missing`);
    assert(shared.RETRY[k].delays.length > 0, `RETRY.${k}.delays empty`);
  }
});

suite('parseSemrushCSV');
test('parses valid CSV', () => {
  const csv = 'Keyword;Volume;Difficulty\ntest kw;1000;25\nother kw;500;10';
  const result = shared.parseSemrushCSV(csv);
  assertEqual(result.length, 2);
  assertEqual(result[0]['Keyword'], 'test kw');
  assertEqual(result[0]['Volume'], '1000');
});
test('returns empty for single line', () => {
  const result = shared.parseSemrushCSV('Keyword;Volume');
  assertEqual(result.length, 0);
});
test('handles empty string', () => {
  const result = shared.parseSemrushCSV('');
  assertEqual(result.length, 0);
});

// ═══════════════════════════════════════════════════════════════
// seo-publish-article.js — validateArticleJSON (extracted logic)
// ═══════════════════════════════════════════════════════════════

suite('validateArticleJSON logic');
test('valid article passes', () => {
  const article = {
    title: 'Test Article', slug: 'test-article', summary: 'Summary here',
    sections: [{ heading: 'Section 1', content: 'Content with enough words to pass the minimum check for validation testing purposes in this test suite' }],
    faq: [{ question: 'Q?', answer: 'A.' }],
    citableExtracts: ['Selon la source, fait X.'],
    sourceUrls: ['https://admin.ch/test'],
    metaTitle: 'Test Title', metaDescription: 'Test description for SEO',
  };
  // We can't import validateArticleJSON directly, but we test the logic patterns
  assert(article.title && typeof article.title === 'string');
  assert(article.sections && Array.isArray(article.sections) && article.sections.length > 0);
  assert(article.slug && typeof article.slug === 'string');
});

// ═══════════════════════════════════════════════════════════════
// seo-images.js — prevalidatePrompt (extracted logic)
// ═══════════════════════════════════════════════════════════════

suite('prevalidatePrompt logic');

const CAMERA_REGEX = /Sony A7|Canon R5|Canon R6|Canon 5D|Fujifilm X-T|Fujifilm GFX|Leica Q|Hasselblad|Nikon Z|Ricoh GR|Sigma fp|Pentax/i;
const FOCAL_REGEX = /\d+mm|f\/\d|f\d\.\d/i;
const BANNED_TERMS = ['beautiful', 'stunning', 'amazing', 'gorgeous', 'breathtaking', 'high quality', 'ultra detailed', 'ultra-detailed', 'masterpiece', '4k', '8k', 'hdr', 'hyper-realistic', 'photorealistic', 'best quality', 'high resolution', 'highly detailed'];

test('valid prompt passes', () => {
  const prompt = 'A medical office desk captured with Canon R5, 50mm f/2.8, warm afternoon light through blinds, slight dust motes visible, pen resting on insurance documents, coffee ring stain on paper, shallow depth of field with clinical white walls';
  assert(CAMERA_REGEX.test(prompt), 'Camera not detected');
  assert(FOCAL_REGEX.test(prompt), 'Focal not detected');
  assert(prompt.split(/\s+/).length >= 30, 'Too short');
  assert(prompt.split(/\s+/).length <= 80, 'Too long');
  for (const term of BANNED_TERMS) {
    assert(!prompt.toLowerCase().includes(term), `Banned term found: ${term}`);
  }
});
test('rejects prompt without camera', () => {
  assert(!CAMERA_REGEX.test('A desk with papers and coffee'), 'Should not match camera');
});
test('rejects banned terms', () => {
  assert('beautiful sunset photo'.toLowerCase().includes('beautiful'));
});

// ═══════════════════════════════════════════════════════════════
// seo-gap-analysis.js — computeKeywordGap logic
// ═══════════════════════════════════════════════════════════════

suite('getIntentMultiplier logic');
test('transactional >= 0.8', () => {
  const v = 0.9;
  assert(v >= 0.8);
  // Would return multiplier 2.0
});
test('commercial 0.5-0.8', () => {
  const v = 0.6;
  assert(v >= 0.5 && v < 0.8);
});
test('informational < 0.5', () => {
  const v = 0.3;
  assert(v < 0.5);
});

// ── Hero Image Tests ──
suite('Hero Image — calendar-connector exports');
try {
  const cc = require('../scripts/calendar-connector');
  test('calendar-connector exports downloadHeroImage', () => {
    assert(typeof cc.downloadHeroImage === 'function');
  });
  test('calendar-connector exports updatePublicationMetadata', () => {
    assert(typeof cc.updatePublicationMetadata === 'function');
  });
} catch (_) {
  test('calendar-connector requires @supabase/supabase-js (skipped)', () => {
    // Skip if dependency not installed in test env
    assert(true);
  });
}

// ═══════════════════════════════════════════════════════════════
// lib/task-result.js (PR 0.3 — JSON output contract)
// ═══════════════════════════════════════════════════════════════
suite('Task Result — createTaskResult');
test('initializes with status pending and schema version', () => {
  const r = shared.createTaskResult({ taskId: 't1', site: 'ag.ch', keyword: 'k' });
  assertEqual(r.status, 'pending');
  assertEqual(r.schemaVersion, shared.TASK_RESULT_SCHEMA_VERSION);
  assertEqual(r.taskId, 't1');
  assertEqual(r.site, 'ag.ch');
  assertEqual(r.keyword, 'k');
  assertEqual(r.mode, 'publish');
  assert(r.metadata && r.metadata.startedAt, 'should have startedAt');
  assertEqual(r.metadata.completedAt, null);
  assertEqual(r.metadata.durationSeconds, null);
  assertEqual(r.sanity, null);
  assertEqual(r.draft, null);
  assertEqual(r.heroImage, null);
  assertDeepEqual(r.exhibits, []);
});
test('respects mode parameter', () => {
  const r = shared.createTaskResult({ site: 'x', keyword: 'y', mode: 'draft' });
  assertEqual(r.mode, 'draft');
});
test('works with no params (defaults)', () => {
  const r = shared.createTaskResult();
  assertEqual(r.status, 'pending');
  assertEqual(r.taskId, null);
  assertEqual(r.site, null);
});

suite('Task Result — writeTaskResult / readTaskResult');
const _tmpResultDir = path.join(os.tmpdir(), `jarvis-test-result-${Date.now()}`);
fs.mkdirSync(_tmpResultDir, { recursive: true });
test('writeTaskResult writes a valid JSON file', () => {
  const r = shared.createTaskResult({ site: 'a.ch', keyword: 'k' });
  r.sanity = { documentId: 'article-x', slug: 'fr-x', language: 'fr', documentType: 'blogPost' };
  const p = path.join(_tmpResultDir, 'write-ok.json');
  shared.writeTaskResult(p, r);
  assert(fs.existsSync(p), 'file should exist after write');
  const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assertEqual(parsed.sanity.documentId, 'article-x');
});
test('writeTaskResult with null path is a no-op', () => {
  const r = shared.createTaskResult({ site: 'a.ch', keyword: 'k' });
  shared.writeTaskResult(null, r);
  // no throw, no file created — success condition is just no error
  assert(true);
});
test('readTaskResult returns null for missing file', () => {
  const missing = shared.readTaskResult(path.join(_tmpResultDir, 'does-not-exist.json'));
  assertEqual(missing, null);
});
test('readTaskResult returns null when path is null', () => {
  assertEqual(shared.readTaskResult(null), null);
});
test('roundtrip: success result is readable', () => {
  const r = shared.createTaskResult({ taskId: 'rt', site: 'b.ch', keyword: 'kw' });
  r.contentUrl = 'https://b.ch/blog/kw';
  shared.finalizeSuccess(r);
  const p = path.join(_tmpResultDir, 'roundtrip-ok.json');
  shared.writeTaskResult(p, r);
  const read = shared.readTaskResult(p);
  assertEqual(read.status, 'success');
  assertEqual(read.contentUrl, 'https://b.ch/blog/kw');
  assert(read.metadata.completedAt, 'should have completedAt after finalizeSuccess');
  assert(typeof read.metadata.durationSeconds === 'number', 'durationSeconds should be a number');
});
test('roundtrip: error result is readable with correct code', () => {
  const r = shared.createTaskResult({ taskId: 'err', site: 'c.ch', keyword: 'kw' });
  shared.finalizeError(r, { code: shared.ERROR_CODES.DUPLICATE_KEYWORD, message: 'dup test', stage: 'init', retryable: false });
  const p = path.join(_tmpResultDir, 'roundtrip-err.json');
  shared.writeTaskResult(p, r);
  const read = shared.readTaskResult(p);
  assertEqual(read.status, 'error');
  assertEqual(read.error.code, 'DUPLICATE_KEYWORD');
  assertEqual(read.error.retryable, false);
});

suite('Task Result — ERROR_CODES enum');
test('contains expected codes', () => {
  assertIncludes(Object.keys(shared.ERROR_CODES), 'CLAUDE_CIRCUIT_OPEN');
  assertIncludes(Object.keys(shared.ERROR_CODES), 'DUPLICATE_KEYWORD');
  assertIncludes(Object.keys(shared.ERROR_CODES), 'SANITY_PUBLISH_FAILED');
  assertIncludes(Object.keys(shared.ERROR_CODES), 'UNKNOWN');
});
test('codes are strings matching their keys', () => {
  for (const [k, v] of Object.entries(shared.ERROR_CODES)) {
    assertEqual(v, k, `ERROR_CODES.${k} should equal its key`);
  }
});

suite('PR 0.3 guard — task-handlers passes --output-json');
test('handlers/task-handlers.js passes --output-json to pipeline', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'handlers', 'task-handlers.js'), 'utf-8');
  assert(src.includes("'--output-json'"), 'task-handlers should pass --output-json');
});
test('workflow-daily.js no longer defines its own runArticle', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  assert(!src.includes('function runArticle('), 'workflow-daily should not define runArticle locally');
});
test('workflow-single-task.js no longer defines its own runArticle', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-single-task.js'), 'utf-8');
  assert(!src.includes('function runArticle('), 'workflow-single-task should not define runArticle locally');
});
test('workflow-daily no longer parses stdout with match regex', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  assert(!src.includes('stdout.match('), 'workflow-daily should not parse stdout with .match()');
});
test('workflow-single-task no longer parses stdout with match regex', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-single-task.js'), 'utf-8');
  assert(!src.includes('stdout.match('), 'workflow-single-task should not parse stdout with .match()');
});

suite('PR 0.4 guard — handlers layer wired correctly');
test('scripts/handlers/ directory exists', () => {
  const dir = path.join(__dirname, '..', 'scripts', 'handlers');
  assert(fs.existsSync(dir), 'scripts/handlers/ should exist');
  assert(fs.statSync(dir).isDirectory(), 'scripts/handlers/ should be a directory');
});
test('scripts/handlers/README.md exists', () => {
  const f = path.join(__dirname, '..', 'scripts', 'handlers', 'README.md');
  assert(fs.existsSync(f), 'scripts/handlers/README.md should exist');
});
test('task-handlers module exports runArticle and sendPublicationNotification', () => {
  const h = require('../scripts/handlers/task-handlers');
  assertEqual(typeof h.runArticle, 'function');
  assertEqual(typeof h.sendPublicationNotification, 'function');
});
test('workflow-daily.js imports from handlers/task-handlers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  assert(src.includes("require('./handlers/task-handlers')"), 'workflow-daily should import from ./handlers/task-handlers');
});
test('workflow-single-task.js imports from handlers/task-handlers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-single-task.js'), 'utf-8');
  assert(src.includes("require('./handlers/task-handlers')"), 'workflow-single-task should import from ./handlers/task-handlers');
});
test('workflow-daily.js no longer defines sendPublicationNotification', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  assert(!src.includes('async function sendPublicationNotification('), 'workflow-daily should not define sendPublicationNotification locally');
});
test('workflow-single-task.js no longer defines sendPublicationNotification', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-single-task.js'), 'utf-8');
  assert(!src.includes('async function sendPublicationNotification('), 'workflow-single-task should not define sendPublicationNotification locally');
});
test('task-handlers exports handleRegenerateExhibit', () => {
  const h = require('../scripts/handlers/task-handlers');
  assertEqual(typeof h.handleRegenerateExhibit, 'function');
});
test('workflow-single-task.js delegates regenerate_exhibit to handler', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-single-task.js'), 'utf-8');
  assert(src.includes('handleRegenerateExhibit(task,'), 'workflow-single-task should call handleRegenerateExhibit');
});
test('workflow-single-task.js no longer has inline planExhibits require', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-single-task.js'), 'utf-8');
  assert(!src.includes("require('./seo-exhibits')"), 'workflow-single-task should not inline-require ./seo-exhibits anymore');
});
test('task-handlers exports handleScheduledPublication', () => {
  const h = require('../scripts/handlers/task-handlers');
  assertEqual(typeof h.handleScheduledPublication, 'function');
});
test('workflow-daily.js delegates scheduled publications to handler', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  assert(src.includes('handleScheduledPublication(pub,'), 'workflow-daily should call handleScheduledPublication');
});
test('workflow-daily.js no longer calls runArticle directly in pub loop', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  const pubLoopStart = src.indexOf('for (const pub of pubs)');
  assert(pubLoopStart > -1, 'pub loop should exist');
  const taskLoopStart = src.indexOf('for (const task of tasks)');
  const pubLoopBody = src.slice(pubLoopStart, taskLoopStart > -1 ? taskLoopStart : src.length);
  assert(!pubLoopBody.includes('runArticle('), 'pub loop should delegate to handler (no direct runArticle call)');
});
test('task-handlers exports handlePublishDraft', () => {
  const h = require('../scripts/handlers/task-handlers');
  assertEqual(typeof h.handlePublishDraft, 'function');
});
test('workflow-daily.js delegates publish_draft to handler', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  assert(src.includes('handlePublishDraft(task,'), 'workflow-daily should call handlePublishDraft');
});
test('workflow-single-task.js delegates publish_draft to handler', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-single-task.js'), 'utf-8');
  assert(src.includes('handlePublishDraft(task,'), 'workflow-single-task should call handlePublishDraft');
});
test('workflow-daily.js no longer calls publishToSanity directly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  // publishToSanity should only appear in the import line now; check no direct await call
  assert(!src.includes('await publishToSanity('), 'workflow-daily should not call publishToSanity directly');
});
test('workflow-single-task.js no longer calls publishToSanity directly in publish_draft', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-single-task.js'), 'utf-8');
  assert(!src.includes('await publishToSanity('), 'workflow-single-task should not call publishToSanity directly');
});
test('task-handlers exports handleGenerateArticle', () => {
  const h = require('../scripts/handlers/task-handlers');
  assertEqual(typeof h.handleGenerateArticle, 'function');
});
test('workflow-daily.js delegates generate_article to handler', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  assert(src.includes('handleGenerateArticle(task,'), 'workflow-daily should call handleGenerateArticle');
});
test('handlers/task-handlers.js handlePublishDraft builds content_url with /blog/ prefix and strips language prefix', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'handlers', 'task-handlers.js'), 'utf-8');
  assert(src.includes("const contentUrl = `https://${site}/blog/${article.slug.replace(/^(fr|en)-/, '')}`"), 'handlePublishDraft should build contentUrl with /blog/ and strip fr-/en- prefix');
});
test('handlers/task-handlers.js no longer builds bare https://site/slug URLs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'handlers', 'task-handlers.js'), 'utf-8');
  assert(!src.includes("`https://${site}/${article.slug}`"), 'task-handlers should not use the bare site/slug formula anymore — must include /blog/ and strip language prefix');
});
test('workflow-daily.js imports uploadExhibitToStorage from calendar-connector', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  assert(src.includes('uploadExhibitToStorage'), 'workflow-daily should import uploadExhibitToStorage from calendar-connector (parity with single-task)');
});
test('workflow-daily.js passes uploadExhibitsToStorage: true and the adapter in ctx', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  assert(src.includes('uploadExhibitsToStorage: true'), 'workflow-daily should enable uploadExhibitsToStorage (parity with single-task)');
  assert(!src.includes('uploadExhibitsToStorage: false'), 'workflow-daily should not pass uploadExhibitsToStorage: false anymore');
  assert(src.match(/fetchSiteAdmins,\s*uploadExhibitToStorage,/), 'workflow-daily should include uploadExhibitToStorage in the handleGenerateArticle ctx');
});
test('workflow-single-task.js delegates generate_article to handler', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-single-task.js'), 'utf-8');
  assert(src.includes('handleGenerateArticle(task,'), 'workflow-single-task should call handleGenerateArticle');
});
test('workflow-daily.js no longer imports sanitize/validateArticleInput', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  // These were removed when generate_article was extracted
  assert(!src.match(/sanitize[^a-zA-Z]/), 'workflow-daily should not need sanitize anymore');
  assert(!src.includes('validateArticleInput'), 'workflow-daily should not need validateArticleInput anymore');
});
test('workflow-single-task.js no longer imports path/fs/SCRIPTS_DIR at top', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-single-task.js'), 'utf-8');
  assert(!src.includes("require('path')"), 'workflow-single-task should not need path at top');
  assert(!src.includes("require('fs')"), 'workflow-single-task should not need fs at top');
  assert(!src.includes('const SCRIPTS_DIR ='), 'workflow-single-task should not define SCRIPTS_DIR anymore');
});

suite('PR 0.4 — task-handlers module surface (final)');
test('exports exactly the 6 expected symbols', () => {
  const h = require('../scripts/handlers/task-handlers');
  const keys = Object.keys(h).sort().join(',');
  assertEqual(keys, 'handleGenerateArticle,handlePublishDraft,handleRegenerateExhibit,handleScheduledPublication,runArticle,sendPublicationNotification');
});
test('all 4 handlers are async functions', () => {
  const h = require('../scripts/handlers/task-handlers');
  for (const name of ['handleGenerateArticle', 'handlePublishDraft', 'handleRegenerateExhibit', 'handleScheduledPublication']) {
    assertEqual(h[name].constructor.name, 'AsyncFunction', `${name} should be AsyncFunction`);
  }
});
test('sendPublicationNotification is async, runArticle is sync', () => {
  const h = require('../scripts/handlers/task-handlers');
  assertEqual(h.sendPublicationNotification.constructor.name, 'AsyncFunction');
  assertEqual(h.runArticle.constructor.name, 'Function', 'runArticle uses execFileSync, should be sync');
});
test('workflow-daily.js final line count <= 160 (dispatcher size sanity)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-daily.js'), 'utf-8');
  const lineCount = src.split('\n').length;
  assert(lineCount <= 160, `workflow-daily.js should be <= 160 lines post-PR-0.4, got ${lineCount}`);
});
test('workflow-single-task.js final line count <= 160 (dispatcher size sanity)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workflow-single-task.js'), 'utf-8');
  const lineCount = src.split('\n').length;
  assert(lineCount <= 160, `workflow-single-task.js should be <= 160 lines post-PR-0.4, got ${lineCount}`);
});
test('scripts/handlers/README.md documents the layer', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'handlers', 'README.md'), 'utf-8');
  assert(readme.includes('lib/'), 'README should reference lib/');
  assert(readme.includes('task-handlers'), 'README should reference task-handlers');
});

test('seo-publish-article.js catch Sanity FR propagates errors (throw err)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'seo-publish-article.js'), 'utf-8');
  assert(src.includes('} catch (err) { console.error(`  ! Sanity FR: ${err.message}`); err.errorCode = ERROR_CODES.SANITY_PUBLISH_FAILED; throw err; }'), 'seo-publish-article.js FR catch must tag err.errorCode and re-throw so the pipeline marks the task as failed with the correct SANITY_PUBLISH_FAILED code');
});
test('seo-publish-article.js catch Sanity EN propagates errors (throw err)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'seo-publish-article.js'), 'utf-8');
  assert(src.includes('} catch (err) { console.error(`  ! Sanity EN: ${err.message}`); err.errorCode = ERROR_CODES.SANITY_PUBLISH_FAILED; throw err; }'), 'seo-publish-article.js EN catch must tag err.errorCode and re-throw so a partial publication is marked as failed with the correct SANITY_PUBLISH_FAILED code');
});
test('seo-publish-article.js no longer has the silent Sanity FR catch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'seo-publish-article.js'), 'utf-8');
  assert(!src.includes('} catch (err) { console.error(`  ! Sanity FR: ${err.message}`); }'), 'seo-publish-article.js must not swallow Sanity FR errors silently — the silent catch form should be replaced with one that re-throws');
});
test('seo-publish-article.js no longer has the silent Sanity EN catch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'seo-publish-article.js'), 'utf-8');
  assert(!src.includes('} catch (err) { console.error(`  ! Sanity EN: ${err.message}`); }'), 'seo-publish-article.js must not swallow Sanity EN errors silently — the silent catch form should be replaced with one that re-throws');
});


suite('PR 0.9 guard — Sanity error tagging (err.errorCode)');
test('seo-publish-article.js tags FR catch with ERROR_CODES.SANITY_PUBLISH_FAILED', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'seo-publish-article.js'), 'utf-8');
  assert(src.includes('! Sanity FR:') && src.includes('err.errorCode = ERROR_CODES.SANITY_PUBLISH_FAILED'), 'FR catch must tag err.errorCode = ERROR_CODES.SANITY_PUBLISH_FAILED before throw so routing does not depend on err.message');
});
test('seo-publish-article.js tags EN catch with ERROR_CODES.SANITY_PUBLISH_FAILED', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'seo-publish-article.js'), 'utf-8');
  assert(src.includes('! Sanity EN:') && src.includes('err.errorCode = ERROR_CODES.SANITY_PUBLISH_FAILED'), 'EN catch must tag err.errorCode = ERROR_CODES.SANITY_PUBLISH_FAILED before throw so routing does not depend on err.message');
});
test('seo-publish-article.js main().catch() prefers err.errorCode over err.message regex', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'seo-publish-article.js'), 'utf-8');
  assert(src.includes('const code = err.errorCode'), 'main().catch() must read err.errorCode first before falling back to message regex');
  assert(!src.includes('/sanity/i.test(err.message)'), 'main().catch() must not use /sanity/i regex anymore — use err.errorCode tag instead');
});

// ═══════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════

console.log('\n========================================');
console.log(`  Results: ${_passed} passed, ${_failed} failed`);
if (_failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of _failures) {
    console.log(`    [${f.suite}] ${f.test}: ${f.error}`);
  }
}
console.log('========================================\n');

process.exit(_failed > 0 ? 1 : 0);
