import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, publicConfig, MISSIONS_DIR } from '../config.js';
import {
  inquiriesDao,
  aiReviewsDao,
  replyActionsDao,
} from '../db.js';
import { classify } from '../ai/classifier.js';
import { generateDraft } from '../ai/replyGenerator.js';
import { checkDraft } from '../safety/safetyGuard.js';
import { createAdapter } from '../coupang/adapter.js';
import {
  checkIpGuard,
  getLastStatus as getIpGuardStatus,
  isApiAllowed,
} from '../ipGuard.js';
import {
  getWorkerStatus,
  triggerRunNow,
} from '../worker.js';
import { getProvider, listProviders } from '../ai/llm/provider.js';
import { logger } from '../logger.js';

export const router = express.Router();

function parseFlags(raw) {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function shapeListItem(row) {
  return {
    id: row.id,
    coupangInquiryId: row.coupang_inquiry_id,
    sourceType: row.source_type,
    productName: row.product_name,
    orderIdMasked: row.order_id_masked,
    customerMessage: row.customer_message,
    customerMessageExcerpt: (row.customer_message || '').slice(0, 80),
    status: row.status,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    category: row.category,
    riskLevel: row.risk_level,
    confidence: row.confidence,
    draftReply: row.draft_reply,
    safetyFlags: parseFlags(row.safety_flags),
  };
}

router.get('/dashboard/stats', (_req, res) => {
  const stats = {
    newToday: inquiriesDao.countNewToday(),
    unanswered: inquiriesDao.countByStatus('new') + inquiriesDao.countByStatus('awaiting_approval'),
    draftsReady: inquiriesDao.countByStatus('awaiting_approval'),
    awaitingApproval: inquiriesDao.countByStatus('awaiting_approval'),
    risky: inquiriesDao.countRisky(),
    urgent24h: inquiriesDao.countUrgent24h(),
    onHold: inquiriesDao.countByStatus('on_hold'),
    sent: inquiriesDao.countByStatus('sent'),
  };
  res.json(stats);
});

router.get('/inquiries', (req, res) => {
  const { status, limit } = req.query;
  const rows = inquiriesDao.list({
    status: status || undefined,
    limit: limit ? Number(limit) : 100,
  });
  res.json(rows.map(shapeListItem));
});

router.get('/inquiries/:id', (req, res) => {
  const id = Number(req.params.id);
  const data = inquiriesDao.get(id);
  if (!data) return res.status(404).json({ error: 'not_found' });
  const { inquiry, review, actions } = data;
  res.json({
    inquiry: {
      id: inquiry.id,
      coupangInquiryId: inquiry.coupang_inquiry_id,
      sourceType: inquiry.source_type,
      productName: inquiry.product_name,
      orderIdMasked: inquiry.order_id_masked,
      customerMessage: inquiry.customer_message,
      status: inquiry.status,
      receivedAt: inquiry.received_at,
      updatedAt: inquiry.updated_at,
    },
    review: review
      ? {
          id: review.id,
          category: review.category,
          sentiment: review.sentiment,
          riskLevel: review.risk_level,
          draftReply: review.draft_reply,
          safetyFlags: parseFlags(review.safety_flags),
          confidence: review.confidence,
          createdAt: review.created_at,
        }
      : null,
    actions: actions.map((a) => ({
      id: a.id,
      actionType: a.action_type,
      finalReply: a.final_reply,
      approvedBy: a.approved_by,
      sentAt: a.sent_at,
      resultStatus: a.result_status,
      errorMessage: a.error_message,
    })),
  });
});

router.post('/inquiries/:id/reanalyze', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = inquiriesDao.get(id);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const config = loadConfig();
    const cls = await classify(data.inquiry.customer_message, config);
    const { draft } = await generateDraft(
      {
        inquiry: {
          productName: data.inquiry.product_name,
          customerMessage: data.inquiry.customer_message,
        },
        review: { category: cls.category },
      },
      config,
    );
    const safety = checkDraft({ draft, classifierFlags: cls.safetyFlags });
    const finalFlags = Array.from(new Set([...cls.safetyFlags, ...safety.allFlags]));
    aiReviewsDao.insert(id, {
      category: cls.category,
      sentiment: cls.sentiment,
      riskLevel: cls.riskLevel,
      draftReply: draft,
      safetyFlags: finalFlags,
      confidence: cls.confidence,
    });
    inquiriesDao.setStatus(id, 'awaiting_approval');
    res.json({ ok: true, provider: getProvider(config).id });
  } catch (err) {
    logger.error('reanalyze 실패', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get('/ai/check', async (req, res) => {
  const config = loadConfig();
  const desired = req.query.provider || config?.ai?.provider || 'rule-based';
  const tryConfig = { ...config, ai: { ...(config.ai || {}), provider: desired } };
  const provider = getProvider(tryConfig);
  try {
    const r = await provider.healthCheck();
    res.json({ ok: true, provider: provider.id, ...r });
  } catch (err) {
    res.status(500).json({ ok: false, provider: provider.id, error: err.message });
  }
});

router.get('/ai/providers', (_req, res) => {
  const config = loadConfig();
  res.json({
    current: config?.ai?.provider || 'rule-based',
    available: listProviders(),
  });
});

async function performSend({ id, reply, approvedBy, actionType }) {
  const data = inquiriesDao.get(id);
  if (!data) throw Object.assign(new Error('not_found'), { status: 404 });
  const { inquiry, review } = data;

  // 마지막 safety 재검사 — 운영자가 수정한 경우에도 적용
  const safety = checkDraft({
    draft: reply,
    classifierFlags: review ? parseFlags(review.safety_flags) : [],
  });

  const config = loadConfig();
  if (config.safety?.blockHighRisk && review?.risk_level === 'high' && actionType !== 'direct') {
    const err = new Error('HIGH_RISK_BLOCKED');
    err.status = 400;
    err.detail = '위험도가 높은 문의는 자동 승인 흐름으로 전송할 수 없습니다. 직접 답변(direct)으로 진행하세요.';
    err.flags = safety.allFlags;
    throw err;
  }
  if (safety.blockedFlags.length > 0) {
    const err = new Error('SAFETY_BLOCKED');
    err.status = 400;
    err.detail = '답변 본문에 차단된 표현(약속/보상/PII 등)이 포함되어 있습니다. 수정 후 다시 시도하세요.';
    err.flags = safety.blockedFlags;
    throw err;
  }
  if ((reply || '').length > (config.safety?.maxReplyLength || 1000)) {
    const err = new Error('TOO_LONG');
    err.status = 400;
    err.detail = `답변은 ${config.safety?.maxReplyLength || 1000}자 이하여야 합니다.`;
    throw err;
  }

  const adapter = createAdapter(config);

  // 실제 API 모드일 때만 IP Guard 통과 여부 검사
  if (adapter.getMode() === 'real' && !isApiAllowed(config)) {
    const err = new Error('IP_GUARD_BLOCKED');
    err.status = 403;
    err.detail = 'IP Guard 상태가 OK가 아닙니다. 등록된 공인 IP에서만 실제 API를 호출할 수 있습니다.';
    throw err;
  }

  let result;
  try {
    result = await adapter.sendReply({
      coupangInquiryId: inquiry.coupang_inquiry_id,
      message: reply,
    });
  } catch (sendErr) {
    replyActionsDao.insert(id, {
      actionType,
      finalReply: reply,
      approvedBy,
      sentAt: new Date().toISOString(),
      resultStatus: 'failed',
      errorMessage: sendErr.message,
    });
    inquiriesDao.setStatus(id, 'failed');
    throw sendErr;
  }

  replyActionsDao.insert(id, {
    actionType,
    finalReply: reply,
    approvedBy,
    sentAt: new Date().toISOString(),
    resultStatus: result.mock ? 'mock' : result.ok ? 'success' : 'failed',
    errorMessage: result.error || null,
  });
  inquiriesDao.setStatus(id, result.ok ? 'sent' : 'failed');
  return { ok: result.ok, mock: !!result.mock };
}

router.post('/inquiries/:id/approve', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { reply, approvedBy } = req.body || {};
    if (!reply || typeof reply !== 'string') {
      return res.status(400).json({ error: 'reply_required' });
    }
    const config = loadConfig();
    const out = await performSend({
      id,
      reply,
      approvedBy: approvedBy || config.operator?.displayName || 'operator',
      actionType: 'approve_send',
    });
    res.json(out);
  } catch (err) {
    logger.warn('approve 실패', { error: err.message, detail: err.detail });
    res.status(err.status || 500).json({
      error: err.message,
      detail: err.detail,
      flags: err.flags,
    });
  }
});

router.post('/inquiries/:id/direct', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { reply, approvedBy } = req.body || {};
    if (!reply || typeof reply !== 'string') {
      return res.status(400).json({ error: 'reply_required' });
    }
    const config = loadConfig();
    const out = await performSend({
      id,
      reply,
      approvedBy: approvedBy || config.operator?.displayName || 'operator',
      actionType: 'direct',
    });
    res.json(out);
  } catch (err) {
    logger.warn('direct 실패', { error: err.message, detail: err.detail });
    res.status(err.status || 500).json({
      error: err.message,
      detail: err.detail,
      flags: err.flags,
    });
  }
});

router.post('/inquiries/:id/hold', (req, res) => {
  const id = Number(req.params.id);
  const config = loadConfig();
  const approvedBy = req.body?.approvedBy || config.operator?.displayName || 'operator';
  const data = inquiriesDao.get(id);
  if (!data) return res.status(404).json({ error: 'not_found' });
  replyActionsDao.insert(id, {
    actionType: 'hold',
    finalReply: null,
    approvedBy,
    sentAt: new Date().toISOString(),
    resultStatus: 'hold',
    errorMessage: null,
  });
  inquiriesDao.setStatus(id, 'on_hold');
  res.json({ ok: true });
});

router.get('/ip-guard/status', (_req, res) => {
  res.json(getIpGuardStatus());
});

router.post('/ip-guard/check', async (_req, res) => {
  const config = loadConfig();
  const status = await checkIpGuard(config);
  res.json(status);
});

router.get('/worker/status', (_req, res) => {
  res.json(getWorkerStatus());
});

router.post('/worker/run-now', async (_req, res) => {
  const status = await triggerRunNow();
  res.json(status);
});

router.get('/config', (_req, res) => {
  res.json(publicConfig(loadConfig()));
});

router.patch('/config', (req, res) => {
  const allowed = {};
  const body = req.body || {};
  if (typeof body.mode === 'string' && ['mock', 'real'].includes(body.mode)) {
    allowed.mode = body.mode;
  }
  if (typeof body.pollIntervalMinutes === 'number' && body.pollIntervalMinutes >= 1) {
    allowed.pollIntervalMinutes = Math.floor(body.pollIntervalMinutes);
  }
  if (typeof body.ipGuardIntervalMinutes === 'number' && body.ipGuardIntervalMinutes >= 1) {
    allowed.ipGuardIntervalMinutes = Math.floor(body.ipGuardIntervalMinutes);
  }
  allowed.coupang = {};
  if (body.coupang && typeof body.coupang.vendorId === 'string') {
    allowed.coupang.vendorId = body.coupang.vendorId;
  }
  if (body.coupang && typeof body.coupang.registeredIp === 'string') {
    allowed.coupang.registeredIp = body.coupang.registeredIp.trim();
  }
  if (body.coupang && typeof body.coupang.apiEnabled === 'boolean') {
    allowed.coupang.apiEnabled = body.coupang.apiEnabled;
  }
  allowed.safety = {};
  if (body.safety && typeof body.safety.requireApprovalForAll === 'boolean') {
    allowed.safety.requireApprovalForAll = body.safety.requireApprovalForAll;
  }
  if (body.safety && typeof body.safety.blockHighRisk === 'boolean') {
    allowed.safety.blockHighRisk = body.safety.blockHighRisk;
  }
  if (body.safety && typeof body.safety.maxReplyLength === 'number') {
    allowed.safety.maxReplyLength = Math.max(100, Math.min(4000, body.safety.maxReplyLength));
  }
  allowed.ai = {};
  if (body.ai && typeof body.ai.provider === 'string' && listProviders().includes(body.ai.provider)) {
    allowed.ai.provider = body.ai.provider;
  }
  if (body.ai && typeof body.ai.fallbackToRules === 'boolean') {
    allowed.ai.fallbackToRules = body.ai.fallbackToRules;
  }
  if (body.ai && body.ai.claudeCli && typeof body.ai.claudeCli === 'object') {
    allowed.ai.claudeCli = {};
    if (typeof body.ai.claudeCli.binary === 'string' && body.ai.claudeCli.binary.length < 200) {
      allowed.ai.claudeCli.binary = body.ai.claudeCli.binary;
    }
    if (body.ai.claudeCli.model === null || typeof body.ai.claudeCli.model === 'string') {
      allowed.ai.claudeCli.model = body.ai.claudeCli.model || null;
    }
    if (typeof body.ai.claudeCli.timeoutSeconds === 'number') {
      allowed.ai.claudeCli.timeoutSeconds = Math.max(5, Math.min(300, body.ai.claudeCli.timeoutSeconds));
    }
    if (typeof body.ai.claudeCli.maskPiiBeforeSending === 'boolean') {
      allowed.ai.claudeCli.maskPiiBeforeSending = body.ai.claudeCli.maskPiiBeforeSending;
    }
  }
  const next = saveConfig(allowed);
  res.json(publicConfig(next));
});

router.get('/missions', (_req, res) => {
  if (!fs.existsSync(MISSIONS_DIR)) return res.json([]);
  const out = [];
  for (const file of fs.readdirSync(MISSIONS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(MISSIONS_DIR, file), 'utf-8')));
    } catch (err) {
      logger.warn('mission json 파싱 실패', { file, error: err.message });
    }
  }
  res.json(out);
});
