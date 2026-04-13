/**
 * calendar-connector.js
 * Thin adapter between Jarvis Calendar (Supabase) and the SEO pipeline.
 *
 * Reads publications & tasks from Supabase, marks them done/failed.
 * No business logic — that lives in workflow-daily.js and seo-orchestrator.js.
 *
 * Jarvis One — A26K Group
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');
const { loadSecret, logger, createCircuitBreaker } = require('./seo-shared');

const breaker = createCircuitBreaker('supabase', { threshold: 3, cooldownMs: 120000 });

// ─── Supabase client (service_role, bypasses RLS) ─────────────

let _client = null;

function getClient() {
  if (_client) return _client;
  const secret = loadSecret('supabase');
  if (!secret.url || !secret.service_role_key) {
    throw new Error('secrets/supabase.json must contain "url" and "service_role_key"');
  }
  _client = createClient(secret.url, secret.service_role_key);
  return _client;
}

// ─── Circuit breaker wrapper ──────────────────────────────────

async function withBreaker(label, fn) {
  if (!breaker.canExecute()) {
    throw new Error(`Supabase circuit breaker OPEN — ${label} skipped`);
  }
  try {
    const result = await fn();
    breaker.recordSuccess();
    return result;
  } catch (e) {
    breaker.recordFailure();
    throw e;
  }
}

// ─── Readers ──────────────────────────────────────────────────

/**
 * Fetch today's scheduled publications, joined with website domain.
 * @returns {Promise<Array<{id, website_id, title, theme, brief, domain, sanity_document_type}>>}
 */
async function fetchTodayPublications() {
  return withBreaker('fetchTodayPublications', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await getClient()
      .from('publications')
      .select('id, website_id, title, theme, brief, metadata, hero_image_path, websites(domain, sanity_document_type)')
      .eq('publish_date', today)
      .eq('status', 'scheduled');

    if (error) throw new Error(`fetchTodayPublications: ${error.message}`);

    return (data || []).map((p) => ({
      id: p.id,
      website_id: p.website_id,
      title: p.title,
      theme: p.theme,
      brief: p.brief,
      metadata: p.metadata,
      hero_image_path: p.hero_image_path || null,
      domain: p.websites?.domain || null,
      sanity_document_type: p.websites?.sanity_document_type || null,
    }));
  });
}

/**
 * Fetch and claim pending tasks from jarvis_tasks.
 * Atomically transitions pending→processing to prevent concurrent duplicates.
 * Only fetches tasks whose scheduled_at is in the past (or NULL for legacy tasks).
 * @returns {Promise<Array<{id, action, publication_id, payload}>>}
 */
async function fetchPendingTasks() {
  return withBreaker('fetchPendingTasks', async () => {
    const now = new Date().toISOString();

    // 1. Read pending tasks whose scheduled_at is past or null
    const { data: pending, error: readErr } = await getClient()
      .from('jarvis_tasks')
      .select('id, action, publication_id, payload, scheduled_at, priority')
      .eq('status', 'pending')
      .or(`scheduled_at.is.null,scheduled_at.lte.${now}`)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true });

    if (readErr) throw new Error(`fetchPendingTasks: ${readErr.message}`);
    if (!pending || pending.length === 0) return [];

    // 2. Claim them by setting status='processing' (only rows still pending)
    const ids = pending.map((t) => t.id);
    const { data: claimed, error: claimErr } = await getClient()
      .from('jarvis_tasks')
      .update({ status: 'processing' })
      .in('id', ids)
      .eq('status', 'pending')
      .select('id, action, publication_id, payload');

    if (claimErr) throw new Error(`claimTasks: ${claimErr.message}`);
    logger.info(`Claimed ${(claimed || []).length}/${pending.length} pending tasks`);
    return claimed || [];
  });
}

// ─── Writers ──────────────────────────────────────────────────

/**
 * Mark a publication as published and store the content URL.
 * @param {string} publicationId
 * @param {string} contentUrl
 */
async function markPublished(publicationId, contentUrl) {
  return withBreaker('markPublished', async () => {
    const { error } = await getClient()
      .from('publications')
      .update({ status: 'published', content_url: contentUrl })
      .eq('id', publicationId);

    if (error) throw new Error(`markPublished(${publicationId}): ${error.message}`);
    logger.info(`Publication ${publicationId} marked published`);
  });
}

/**
 * Acknowledge a task as completed.
 * @param {string} taskId
 * @param {object} result
 */
async function ackTask(taskId, result) {
  return withBreaker('ackTask', async () => {
    const { error } = await getClient()
      .from('jarvis_tasks')
      .update({ status: 'completed', result: result || {}, completed_at: new Date().toISOString() })
      .eq('id', taskId);

    if (error) throw new Error(`ackTask(${taskId}): ${error.message}`);
    logger.info(`Task ${taskId} completed`);
  });
}

/**
 * Mark a task as failed.
 * @param {string} taskId
 * @param {string} errorMsg
 */
async function failTask(taskId, errorMsg) {
  return withBreaker('failTask', async () => {
    const { error } = await getClient()
      .from('jarvis_tasks')
      .update({ status: 'failed', error: errorMsg, completed_at: new Date().toISOString() })
      .eq('id', taskId);

    if (error) throw new Error(`failTask(${taskId}): ${error.message}`);
    logger.warn(`Task ${taskId} failed: ${errorMsg}`);
  });
}

// ─── Hero Image ──────────────────────────────────────────────

/**
 * Download hero image from Supabase Storage to a local temp file.
 * Uses service_role key so no RLS issues.
 * @param {string} storagePath - path in the publication-files bucket
 * @returns {Promise<string>} - local temp file path
 */
async function downloadHeroImage(storagePath) {
  return withBreaker('downloadHeroImage', async () => {
    const { data, error } = await getClient()
      .storage
      .from('publication-files')
      .download(storagePath);

    if (error) throw new Error(`downloadHeroImage: ${error.message}`);
    if (!data) throw new Error('downloadHeroImage: pas de donnees');

    const ext = storagePath.split('.').pop() || 'jpg';
    const tmpPath = path.join(os.tmpdir(), `hero-${Date.now()}.${ext}`);
    const buffer = Buffer.from(await data.arrayBuffer());
    fs.writeFileSync(tmpPath, buffer);
    logger.info(`Hero image downloaded: ${tmpPath} (${buffer.length} bytes)`);
    return tmpPath;
  });
}

/**
 * Update publication metadata (merge with existing).
 * @param {string} publicationId
 * @param {object} metadataUpdates - keys/values to merge into metadata JSONB
 */
async function updatePublicationMetadata(publicationId, metadataUpdates) {
  return withBreaker('updatePublicationMetadata', async () => {
    const { data: pub, error: readErr } = await getClient()
      .from('publications')
      .select('metadata')
      .eq('id', publicationId)
      .single();

    if (readErr) throw new Error(`updatePublicationMetadata read: ${readErr.message}`);

    const merged = { ...(pub?.metadata || {}), ...metadataUpdates };

    const { error } = await getClient()
      .from('publications')
      .update({ metadata: merged })
      .eq('id', publicationId);

    if (error) throw new Error(`updatePublicationMetadata: ${error.message}`);
    logger.info(`Publication ${publicationId} metadata updated: ${JSON.stringify(metadataUpdates)}`);
  });
}

// ─── Exports ──────────────────────────────────────────────────

module.exports = {
  getClient,
  fetchTodayPublications,
  fetchPendingTasks,
  markPublished,
  ackTask,
  failTask,
  downloadHeroImage,
  updatePublicationMetadata,
};
