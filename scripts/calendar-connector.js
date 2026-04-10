/**
 * calendar-connector.js
 * Thin adapter between Jarvis Calendar (Supabase) and the SEO pipeline.
 *
 * Reads publications & tasks from Supabase, marks them done/failed.
 * No business logic — that lives in workflow-daily.js and seo-orchestrator.js.
 *
 * Jarvis One — A26K Group
 */
const { createClient } = require('@supabase/supabase-js');
const { loadSecret, logger } = require('./seo-shared');

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

// ─── Readers ──────────────────────────────────────────────────

/**
 * Fetch today's scheduled publications, joined with website domain.
 * @returns {Promise<Array<{id, website_id, title, theme, brief, domain, sanity_document_type}>>}
 */
async function fetchTodayPublications() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await getClient()
    .from('publications')
    .select('id, website_id, title, theme, brief, metadata, websites(domain, sanity_document_type)')
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
    domain: p.websites?.domain || null,
    sanity_document_type: p.websites?.sanity_document_type || null,
  }));
}

/**
 * Fetch pending tasks from jarvis_tasks.
 * @returns {Promise<Array<{id, action, publication_id, payload}>>}
 */
async function fetchPendingTasks() {
  const { data, error } = await getClient()
    .from('jarvis_tasks')
    .select('id, action, publication_id, payload')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`fetchPendingTasks: ${error.message}`);
  return data || [];
}

// ─── Writers ──────────────────────────────────────────────────

/**
 * Mark a publication as published and store the content URL.
 * @param {string} publicationId
 * @param {string} contentUrl
 */
async function markPublished(publicationId, contentUrl) {
  const { error } = await getClient()
    .from('publications')
    .update({ status: 'published', content_url: contentUrl })
    .eq('id', publicationId);

  if (error) throw new Error(`markPublished(${publicationId}): ${error.message}`);
  logger.info(`Publication ${publicationId} marked published`);
}

/**
 * Acknowledge a task as completed.
 * @param {string} taskId
 * @param {object} result
 */
async function ackTask(taskId, result) {
  const { error } = await getClient()
    .from('jarvis_tasks')
    .update({ status: 'completed', result: result || {}, completed_at: new Date().toISOString() })
    .eq('id', taskId);

  if (error) throw new Error(`ackTask(${taskId}): ${error.message}`);
  logger.info(`Task ${taskId} completed`);
}

/**
 * Mark a task as failed.
 * @param {string} taskId
 * @param {string} errorMsg
 */
async function failTask(taskId, errorMsg) {
  const { error } = await getClient()
    .from('jarvis_tasks')
    .update({ status: 'failed', error: errorMsg, completed_at: new Date().toISOString() })
    .eq('id', taskId);

  if (error) throw new Error(`failTask(${taskId}): ${error.message}`);
  logger.warn(`Task ${taskId} failed: ${errorMsg}`);
}

// ─── Exports ──────────────────────────────────────────────────

module.exports = {
  getClient,
  fetchTodayPublications,
  fetchPendingTasks,
  markPublished,
  ackTask,
  failTask,
};
