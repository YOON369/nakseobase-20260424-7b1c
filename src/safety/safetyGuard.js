/**
 * Safety Guard
 *
 *   checkDraft({ draft, classifierFlags }): {
 *     blockedFlags: string[],    // 자동 차단 (즉시 전송 금지)
 *     warningFlags: string[],    // 경고 (운영자 주의)
 *     requiresApproval: boolean
 *   }
 */

const REFUND_PROMISE_RE = /(무조건|반드시|꼭|100[%％]).*?환불/;
const COMPENSATION_PROMISE_RE = /(보상|배상).*(드리겠|해드리|약속)/;
const ABSOLUTE_PROMISE_RE = /(약속드리|보장드리|확실하게.*?처리)/;
const POLICY_CONFLICT_RE = /(임의로.*?환불|규정.*?무시|예외.*?처리)/;
const RUDE_RE = /(짜증|닥쳐|꺼져|미친)/;
const PHONE_RE = /\b0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const RRN_RE = /\b\d{6}-\d{7}\b/;

export function checkDraft({ draft = '', classifierFlags = [] }) {
  const blocked = [];
  const warning = [];

  if (REFUND_PROMISE_RE.test(draft)) blocked.push('REFUND_PROMISE');
  if (COMPENSATION_PROMISE_RE.test(draft)) blocked.push('COMPENSATION_PROMISE');
  if (ABSOLUTE_PROMISE_RE.test(draft)) blocked.push('POLICY_CONFLICT');
  if (POLICY_CONFLICT_RE.test(draft)) blocked.push('POLICY_CONFLICT');
  if (RUDE_RE.test(draft)) blocked.push('RUDE_LANGUAGE');

  if (PHONE_RE.test(draft) || EMAIL_RE.test(draft) || RRN_RE.test(draft)) {
    blocked.push('PRIVACY_EXPOSURE');
  }

  for (const f of classifierFlags) {
    if (['LEGAL_THREAT', 'PRIVACY_EXPOSURE', 'UNKNOWN_ORDER_STATUS', 'MANUAL_REVIEW_REQUIRED'].includes(f)) {
      warning.push(f);
    } else if (!warning.includes(f)) {
      warning.push(f);
    }
  }

  const merged = Array.from(new Set([...blocked, ...warning]));

  return {
    blockedFlags: Array.from(new Set(blocked)),
    warningFlags: Array.from(new Set(warning)),
    allFlags: merged,
    requiresApproval: true, // MVP: 항상 사람 승인 필요
  };
}
