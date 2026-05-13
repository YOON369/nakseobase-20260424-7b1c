import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { createAdapter } from './coupang/adapter.js';
import { checkIpGuard } from './ipGuard.js';
import { classify } from './ai/classifier.js';
import { generateDraft } from './ai/replyGenerator.js';
import { checkDraft } from './safety/safetyGuard.js';
import { inquiriesDao, aiReviewsDao } from './db.js';

const state = {
  running: false,
  lastSyncAt: null,
  lastError: null,
  runCount: 0,
  lastBatchStats: null,
  syncTimer: null,
  ipTimer: null,
  isCurrentlySyncing: false,
};

async function syncInquiries(adapter) {
  const raws = await adapter.listInquiries();
  let inserted = 0;
  for (const raw of raws) {
    const { isNew } = inquiriesDao.upsertNew(raw);
    if (isNew) inserted += 1;
  }
  return { fetched: raws.length, inserted };
}

async function analyzePending(config) {
  const pending = inquiriesDao.listNeedingAnalysis();
  let analyzed = 0;
  let highRisk = 0;
  let failed = 0;
  for (const inq of pending) {
    try {
      const cls = await classify(inq.customer_message, config);
      const { draft } = await generateDraft(
        {
          inquiry: { productName: inq.product_name, customerMessage: inq.customer_message },
          review: { category: cls.category },
        },
        config,
      );
      const safety = checkDraft({ draft, classifierFlags: cls.safetyFlags });
      const finalFlags = Array.from(new Set([...cls.safetyFlags, ...safety.allFlags]));
      aiReviewsDao.insert(inq.id, {
        category: cls.category,
        sentiment: cls.sentiment,
        riskLevel: cls.riskLevel,
        draftReply: draft,
        safetyFlags: finalFlags,
        confidence: cls.confidence,
      });
      inquiriesDao.setStatus(inq.id, 'awaiting_approval');
      analyzed += 1;
      if (cls.riskLevel === 'high') highRisk += 1;
    } catch (err) {
      failed += 1;
      logger.error('문의 분석 실패', { inquiryId: inq.id, error: err.message });
    }
  }
  return { analyzed, highRisk, failed };
}

async function runOnce() {
  if (state.isCurrentlySyncing) {
    logger.debug('Worker tick skipped (already running)');
    return;
  }
  state.isCurrentlySyncing = true;
  const startedAt = new Date().toISOString();
  try {
    const config = loadConfig();
    const adapter = createAdapter(config);
    const sync = await syncInquiries(adapter);
    const analysis = await analyzePending(config);
    state.lastBatchStats = { ...sync, ...analysis, startedAt };
    state.lastSyncAt = new Date().toISOString();
    state.lastError = null;
    state.runCount += 1;
    logger.info('Worker tick 완료', state.lastBatchStats);
  } catch (err) {
    state.lastError = err.message;
    logger.error('Worker tick 실패', { error: err.message });
  } finally {
    state.isCurrentlySyncing = false;
  }
}

async function runIpGuard() {
  try {
    const config = loadConfig();
    await checkIpGuard(config);
  } catch (err) {
    logger.warn('IP Guard 체크 실패', { error: err.message });
  }
}

export function startWorker() {
  if (state.running) return;
  state.running = true;
  const config = loadConfig();
  const syncMs = Math.max(1, config.pollIntervalMinutes || 5) * 60 * 1000;
  const ipMs = Math.max(1, config.ipGuardIntervalMinutes || 1) * 60 * 1000;
  state.syncTimer = setInterval(runOnce, syncMs);
  state.ipTimer = setInterval(runIpGuard, ipMs);
  // 즉시 1회 실행
  runOnce();
  runIpGuard();
  logger.info('Worker 시작', { syncMs, ipMs });
}

export function stopWorker() {
  if (!state.running) return;
  if (state.syncTimer) clearInterval(state.syncTimer);
  if (state.ipTimer) clearInterval(state.ipTimer);
  state.syncTimer = null;
  state.ipTimer = null;
  state.running = false;
  logger.info('Worker 중지');
}

export function getWorkerStatus() {
  return {
    running: state.running,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
    runCount: state.runCount,
    lastBatchStats: state.lastBatchStats,
  };
}

export async function triggerRunNow() {
  await runOnce();
  await runIpGuard();
  return getWorkerStatus();
}
