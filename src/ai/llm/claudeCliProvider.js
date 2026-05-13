/**
 * Claude CLI provider.
 *
 * 사용자의 로컬 `claude` CLI(=Claude Code)를 subprocess로 호출해
 * Claude API key 없이 사용자의 Claude 구독으로 분류/답변 초안을 만든다.
 *
 *  - `claude -p` 비대화형 모드 사용
 *  - `--output-format json --json-schema` 로 구조화 출력 강제
 *  - JSON 응답의 `structured_output` 필드를 결과로 사용
 *  - PII는 기본적으로 호출 전에 마스킹 (옵션)
 *  - 실패 시 호출자가 ruleProvider로 폴백할 수 있도록 명확한 에러 발생
 */

import { spawn } from 'node:child_process';
import { ruleClassify, ALLOWED_CATEGORIES, ALLOWED_FLAGS } from './ruleProvider.js';
import { logger } from '../../logger.js';

const DEFAULT_BIN = 'claude';
const DEFAULT_TIMEOUT_S = 60;

const PII = {
  RRN: /\b\d{6}-\d{7}\b/g,
  EMAIL: /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  PHONE: /\b0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g,
};

function maskPii(text) {
  return String(text || '')
    .replace(PII.RRN, '[RRN]')
    .replace(PII.EMAIL, '[EMAIL]')
    .replace(PII.PHONE, '[PHONE]');
}

function runCli({ binary, args, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(err);
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(t);
      if (timedOut) return reject(new Error('claude CLI timeout'));
      if (code !== 0) {
        return reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 300).trim()}`));
      }
      resolve({ stdout, stderr });
    });
    if (input != null) {
      try {
        proc.stdin.write(input);
      } catch (err) {
        clearTimeout(t);
        return reject(err);
      }
      proc.stdin.end();
    }
  });
}

const CLASSIFY_SYSTEM = `You are a customer service triage assistant for a Coupang seller in South Korea.
You read a customer message in Korean and output a strict structured JSON via the provided JSON schema.
Rules:
- If the message mentions 신고 / 소비자원 / 고소 / 법적 / 분쟁 / 소송 → riskLevel "high" and include "LEGAL_THREAT".
- If the message contains phone, email, RRN, address → include "PRIVACY_EXPOSURE".
- If category is one of [환불, 파손/누락, 불량, 법적/분쟁 위험] → include "MANUAL_REVIEW_REQUIRED".
- If sentiment is "angry" → include "RUDE_LANGUAGE".
- For 배송 지연 also include "UNKNOWN_ORDER_STATUS".
- Confidence is your self-assessed probability (0..1).
- Output ONLY valid structured output — no commentary, no markdown.`;

const REPLY_SYSTEM = `You draft a polite, professional Korean reply to a Coupang customer inquiry.
Constraints (must follow ALL):
- Korean language only. Plain text. No markdown. No emojis. No greeting hashtags.
- 1000 characters or fewer.
- Never promise refunds, compensation, or guarantees. Forbidden phrases include "무조건 환불", "보상해드리겠습니다", "반드시 환불", "100% 환불", "약속드립니다", "보장드립니다".
- Never include personal information (phone, email, RRN, address).
- If category is high risk (법적/분쟁 위험, 화난 고객) or involves 환불/파손/불량, write a neutral acknowledgement and note that the operator (운영자) will review.
- Output ONLY the reply text via structured output. No explanation.`;

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'sentiment', 'riskLevel', 'safetyFlags', 'confidence'],
  properties: {
    category: { type: 'string', enum: ALLOWED_CATEGORIES },
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'angry'] },
    riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
    safetyFlags: {
      type: 'array',
      items: { type: 'string', enum: ALLOWED_FLAGS },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply'],
  properties: {
    reply: { type: 'string', maxLength: 1000 },
  },
};

function parseCliJson(stdout) {
  // claude --output-format json prints a single JSON object on stdout
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // try to find the first JSON object in stdout
    const m = trimmed.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try { return JSON.parse(m[0]); } catch {}
    }
    throw new Error('claude CLI 응답을 JSON으로 파싱할 수 없음');
  }
}

function extractStructured(envelope) {
  if (envelope?.is_error || envelope?.api_error_status) {
    throw new Error(`claude CLI 응답 오류: ${envelope?.api_error_status || envelope?.subtype || 'unknown'}`);
  }
  if (envelope?.structured_output && typeof envelope.structured_output === 'object') {
    return envelope.structured_output;
  }
  // Fallback: extract JSON from `result` text
  const text = envelope?.result;
  if (typeof text === 'string') {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch {}
    }
  }
  throw new Error('claude CLI 응답에 structured_output이 없음');
}

function sanitizeClassification(obj) {
  const allowedCats = new Set(ALLOWED_CATEGORIES);
  const allowedFlags = new Set(ALLOWED_FLAGS);
  return {
    category: allowedCats.has(obj.category) ? obj.category : '기타',
    sentiment: ['positive', 'neutral', 'negative', 'angry'].includes(obj.sentiment) ? obj.sentiment : 'neutral',
    riskLevel: ['low', 'medium', 'high'].includes(obj.riskLevel) ? obj.riskLevel : 'low',
    safetyFlags: Array.isArray(obj.safetyFlags) ? obj.safetyFlags.filter((f) => allowedFlags.has(f)) : [],
    confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
  };
}

function mergeWithRules(llmResult, ruleResult) {
  // 룰이 high로 본 건은 절대 LLM이 low로 못 내림
  const rank = { low: 0, medium: 1, high: 2 };
  const riskLevel = rank[ruleResult.riskLevel] >= rank[llmResult.riskLevel]
    ? ruleResult.riskLevel
    : llmResult.riskLevel;
  const safetyFlags = Array.from(new Set([...(llmResult.safetyFlags || []), ...(ruleResult.safetyFlags || [])]));
  return { ...llmResult, riskLevel, safetyFlags };
}

export class ClaudeCliProvider {
  constructor(opts = {}) {
    this.id = 'claude-cli';
    this.binary = opts.binary || DEFAULT_BIN;
    this.model = opts.model || null;
    this.timeoutMs = (opts.timeoutSeconds || DEFAULT_TIMEOUT_S) * 1000;
    this.maskPiiBeforeSending = opts.maskPiiBeforeSending !== false;
    this.extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs : [];
  }

  _baseArgs() {
    const args = ['-p', '--no-session-persistence', '--output-format', 'json'];
    if (this.model) args.push('--model', this.model);
    args.push(...this.extraArgs);
    return args;
  }

  async _callStructured({ system, user, schema }) {
    const args = [
      ...this._baseArgs(),
      '--append-system-prompt', system,
      '--json-schema', JSON.stringify(schema),
    ];
    const { stdout } = await runCli({
      binary: this.binary,
      args,
      input: user,
      timeoutMs: this.timeoutMs,
    });
    const envelope = parseCliJson(stdout);
    return { envelope, structured: extractStructured(envelope) };
  }

  async classify(rawMessage) {
    const message = this.maskPiiBeforeSending ? maskPii(rawMessage) : rawMessage;
    const userPrompt = `Customer message:\n"""\n${message}\n"""`;
    let structured;
    try {
      const r = await this._callStructured({
        system: CLASSIFY_SYSTEM,
        user: userPrompt,
        schema: CLASSIFY_SCHEMA,
      });
      structured = r.structured;
    } catch (err) {
      logger.warn('Claude CLI classify 실패', { error: err.message });
      throw err;
    }
    const sanitized = sanitizeClassification(structured);
    const ruleResult = ruleClassify(rawMessage); // 룰은 원문(마스킹 전) 기준
    return mergeWithRules(sanitized, ruleResult);
  }

  async generateDraft({ inquiry, category }) {
    const rawMsg = inquiry?.customerMessage || inquiry?.customer_message || '';
    const message = this.maskPiiBeforeSending ? maskPii(rawMsg) : rawMsg;
    const productName = inquiry?.productName || inquiry?.product_name || '';
    const userPrompt =
      `Category: ${category}\nProduct: ${productName}\n\nCustomer message:\n"""\n${message}\n"""`;
    const { structured } = await this._callStructured({
      system: REPLY_SYSTEM,
      user: userPrompt,
      schema: REPLY_SCHEMA,
    });
    const draft = String(structured?.reply || '').trim().slice(0, 1000);
    if (!draft) throw new Error('Claude CLI 답변 초안이 비어 있음');
    return { draft };
  }

  async healthCheck() {
    const { stdout } = await runCli({
      binary: this.binary,
      args: ['--version'],
      timeoutMs: 8000,
    });
    return { ok: true, version: stdout.trim() };
  }
}
