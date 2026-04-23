#!/usr/bin/env node
/**
 * workflow-single-task.js
 * On-demand entry point — processes a single jarvis_task by ID.
 *
 * Triggered by GitHub Actions workflow_dispatch (jarvis-on-demand.yml).
 * Reuses the same logic as workflow-daily.js sections 1 & 2.
 *
 * Usage: node scripts/workflow-single-task.js --task-id <uuid>
 *
 * Jarvis One — A26K Group
 */
const sentry = require('./lib/sentry');
sentry.init({ script: 'workflow-single-task' });

const { logger, requireAnthropicKey, sendEmail } = require('./seo-shared');
const {
  handleRegenerateExhibit,
  handlePublishDraft,
  handleGenerateArticle,
} = require('./handlers/task-handlers');
const {
  getClient,
  ackTask,
  failTask,
  downloadHeroImage,
  uploadExhibitToStorage,
  updatePublicationMetadata,
  saveDraftContent,
  createNotification,
  fetchSiteAdmins,
  markPublished,
} = require('./calendar-connector');
const { publishToSanity, uploadImageToSanity } = require('./seo-publish-article');

// ─── Parse --task-id from CLI args ───────────────────────────

function parseTaskId() {
  const idx = process.argv.indexOf('--task-id');
  if (idx === -1 || !process.argv[idx + 1]) {
    console.error('Usage: node scripts/workflow-single-task.js --task-id <uuid>');
    process.exit(1);
  }
  const taskId = process.argv[idx + 1];
  // Basic UUID validation
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
    console.error(`Invalid task ID format: ${taskId}`);
    process.exit(1);
  }
  return taskId;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const taskId = parseTaskId();

  console.log('========================================');
  console.log('  Jarvis Calendar — On-Demand Task');
  console.log(`  Task: ${taskId}`);
  console.log(`  ${new Date().toISOString().slice(0, 10)}`);
  console.log('========================================\n');

  const apiKey = requireAnthropicKey();

  // ── Fetch the task ──
  const { data: task, error: fetchErr } = await getClient()
    .from('jarvis_tasks')
    .select('id, action, publication_id, payload, status')
    .eq('id', taskId)
    .single();

  if (fetchErr) {
    console.error(`Failed to fetch task: ${fetchErr.message}`);
    process.exit(1);
  }
  if (!task) {
    console.error(`Task not found: ${taskId}`);
    process.exit(1);
  }

  // ── Claim the task (pending → processing) ──
  if (task.status === 'pending') {
    const { error: claimErr } = await getClient()
      .from('jarvis_tasks')
      .update({ status: 'processing' })
      .eq('id', taskId)
      .eq('status', 'pending');

    if (claimErr) {
      console.error(`Failed to claim task: ${claimErr.message}`);
      process.exit(1);
    }
    console.log('> Task claimed (pending → processing)\n');
  } else if (task.status === 'processing') {
    console.log('> Task already processing — resuming\n');
  } else {
    console.error(`Task status is "${task.status}" — expected pending or processing`);
    process.exit(1);
  }

  try {
    // ── publish_draft action ──
    if (task.action === 'publish_draft') {
      await handlePublishDraft(task, {
        dryRun: false,
        logPrefix: '  ',
        trailingNewline: true,
        client: getClient(),
        ackTask,
        downloadHeroImage,
        uploadImageToSanity,
        publishToSanity,
        fetchSiteAdmins,
        createNotification,
      });
      return;
    }

    // ── regenerate_exhibit action ──
    if (task.action === 'regenerate_exhibit') {
      await handleRegenerateExhibit(task, { client: getClient(), ackTask, uploadExhibitToStorage });
      return;
    }

    // ── generate_article / other actions ──
    await handleGenerateArticle(task, {
      apiKey,
      dryRun: false,
      logPrefix: '  ',
      trailingNewline: true,
      uploadExhibitsToStorage: true,
      announceTask: true,
      logPublishedOk: true,
      logGenericOk: false,
      client: getClient(),
      ackTask,
      downloadHeroImage,
      markPublished,
      updatePublicationMetadata,
      saveDraftContent,
      createNotification,
      fetchSiteAdmins,
      uploadExhibitToStorage,
    });
  } catch (e) {
    logger.error(`Task ${taskId} failed: ${e.message.slice(0, 200)}`);
    await failTask(taskId, e.message.slice(0, 500));
    process.exit(1);
  }
}

main().catch((err) => sentry.fatal(err));
