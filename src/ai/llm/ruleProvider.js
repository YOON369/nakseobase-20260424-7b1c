/**
 * Rule-based AI provider.
 * 기존 한국어 룰 기반 분류/템플릿을 보관하고, LLM provider 인터페이스에 맞춰 노출한다.
 */

const CATEGORIES = [
  { id: '배송 지연', keywords: ['배송', '늦', '안 와', '안와', '도착 안', '왜 아직', '출고', '언제 와', '언제와'] },
  { id: '교환/반품', keywords: ['교환', '반품', '바꿔', '다른 사이즈', '사이즈 안'] },
  { id: '환불', keywords: ['환불', '취소', '돈 돌려', '결제 취소'] },
  { id: '파손/누락', keywords: ['파손', '깨', '찌그', '누락', '빠져', '안 들어', '안들어', '빠짐'] },
  { id: '불량', keywords: ['불량', '고장', '안 켜', '안켜', '작동 안', '작동안', '오작동', '하자'] },
  { id: '사용법 문의', keywords: ['어떻게', '사용법', '쓰는 법', '쓰는법', '방법', '세척', '식기세척기', '관리'] },
  { id: '상품 정보 문의', keywords: ['스펙', '재질', '성분', '사양', '배터리', '시간', '용량', '있나요', '되나요'] },
];

const ANGRY_KEYWORDS = ['짜증', '최악', '별로', '화나', '열받', '진짜', '실망', '쓰레기', '엉망', '망함'];
const LEGAL_KEYWORDS = ['신고', '소비자원', '고소', '법적', '분쟁', '변호사', '소송', '한국소비자원'];
const PRIVACY_RE = /(\b0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}\b)|([\w.+-]+@[\w-]+\.[\w.-]+)|(\b\d{6}-\d{7}\b)/;
const REFUND_DEMAND_RE = /(환불.*?(안|못).*해주면)|(무조건.*환불)/;

function matchScore(text, keywords) {
  let hits = 0;
  for (const k of keywords) {
    if (text.includes(k)) hits += 1;
  }
  return hits;
}

export function ruleClassify(rawMessage) {
  const message = rawMessage || '';
  const flags = [];
  const scored = CATEGORIES.map((c) => ({ id: c.id, score: matchScore(message, c.keywords) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const category = top.score > 0 ? top.id : '기타';

  const angryHits = matchScore(message, ANGRY_KEYWORDS);
  const legalHits = matchScore(message, LEGAL_KEYWORDS);
  const hasPrivacy = PRIVACY_RE.test(message);
  const refundThreat = REFUND_DEMAND_RE.test(message);

  let sentiment = 'neutral';
  if (angryHits >= 2 || refundThreat) sentiment = 'angry';
  else if (angryHits === 1) sentiment = 'negative';

  let riskLevel = 'low';
  if (legalHits > 0 || refundThreat) riskLevel = 'high';
  else if (
    ['환불', '파손/누락', '불량'].includes(category) ||
    sentiment === 'negative' ||
    sentiment === 'angry'
  ) {
    riskLevel = 'medium';
  }
  if (hasPrivacy) riskLevel = riskLevel === 'high' ? 'high' : 'medium';

  if (legalHits > 0) flags.push('LEGAL_THREAT');
  if (hasPrivacy) flags.push('PRIVACY_EXPOSURE');
  if (sentiment === 'angry') flags.push('RUDE_LANGUAGE');
  if (refundThreat) {
    flags.push('LEGAL_THREAT');
    flags.push('MANUAL_REVIEW_REQUIRED');
  }
  if (category === '배송 지연') flags.push('UNKNOWN_ORDER_STATUS');
  if (legalHits > 0 || refundThreat || hasPrivacy) flags.push('MANUAL_REVIEW_REQUIRED');
  if (['환불', '파손/누락', '불량'].includes(category)) {
    if (!flags.includes('MANUAL_REVIEW_REQUIRED')) flags.push('MANUAL_REVIEW_REQUIRED');
  }

  const totalScore = scored.reduce((sum, c) => sum + c.score, 0);
  const confidence = top.score > 0 && totalScore > 0
    ? Math.min(0.95, 0.5 + (top.score / (totalScore + 1)) * 0.5)
    : 0.3;

  return {
    category,
    sentiment,
    riskLevel,
    safetyFlags: Array.from(new Set(flags)),
    confidence: Number(confidence.toFixed(2)),
  };
}

const TEMPLATES = {
  '배송 지연': () =>
    `안녕하세요, 고객님. 주문하신 상품의 배송 지연으로 불편을 드려 죄송합니다.\n` +
    `현재 배송 상태를 즉시 확인하고 있으며, 가능한 한 빠르게 처리될 수 있도록 물류팀에 전달드렸습니다.\n` +
    `확인되는 대로 정확한 출고/도착 예정일을 안내드리겠습니다. 잠시만 기다려 주시면 감사하겠습니다.`,
  '상품 정보 문의': (productName) =>
    `안녕하세요, 고객님. ${productName ? `${productName} 관련` : '상품'} 문의해 주셔서 감사합니다.\n` +
    `문의하신 사양에 대해 정확한 정보를 확인 후 다시 안내드리겠습니다.\n` +
    `상세 페이지에도 사양/사용 가이드를 함께 안내하고 있으니 참고 부탁드립니다.`,
  '교환/반품': () =>
    `안녕하세요, 고객님. 교환/반품 문의 주셔서 감사합니다.\n` +
    `교환·반품 절차와 가능한 옵션을 확인 후 안내드리겠습니다.\n` +
    `상품 상태와 구성품을 함께 알려주시면 더 빠르게 도움드릴 수 있습니다.`,
  '환불': () =>
    `안녕하세요, 고객님. 환불 문의 주셔서 감사합니다.\n` +
    `해당 주문 건의 상태를 확인 후, 환불 가능 여부와 절차를 자세히 안내드리겠습니다.\n` +
    `(주의: 환불 가능 여부는 상품 상태/배송 단계에 따라 달라질 수 있어, 운영자가 직접 확인합니다.)`,
  '파손/누락': () =>
    `안녕하세요, 고객님. 상품 파손/누락으로 불편을 드려 진심으로 죄송합니다.\n` +
    `정확한 상황을 확인하기 위해, 받으신 상품과 박스 사진을 함께 보내주시면 빠르게 처리해드리겠습니다.\n` +
    `확인 후 교환·재발송 등 가능한 조치를 안내드리겠습니다.`,
  '불량': () =>
    `안녕하세요, 고객님. 제품 작동 문제로 불편을 드려 죄송합니다.\n` +
    `정확한 증상 확인을 위해 어떤 상황에서 문제가 발생하는지 간단히 알려주시면 도움이 됩니다.\n` +
    `확인 후 교환·점검 등 가능한 절차를 안내드리겠습니다.`,
  '사용법 문의': (productName) =>
    `안녕하세요, 고객님. ${productName ? `${productName}` : '상품'} 사용 관련 문의 감사합니다.\n` +
    `정확한 사용/관리 방법을 정리해 안내드리겠습니다.\n` +
    `세부 조건(예: 세척 방식, 사용 환경)에 따라 권장 사항이 달라질 수 있어 함께 확인드리겠습니다.`,
  '화난 고객': () =>
    `안녕하세요, 고객님. 불편을 드려 진심으로 죄송합니다.\n` +
    `상황을 빠르게 확인 후 가능한 해결 방안을 안내드리겠습니다.\n` +
    `(이 문의는 운영자가 직접 검토합니다.)`,
  '법적/분쟁 위험': () =>
    `안녕하세요, 고객님. 문의 내용 잘 확인했습니다.\n` +
    `해당 건은 운영자가 직접 검토한 뒤 정확한 절차로 안내드리겠습니다.\n` +
    `(이 답변은 운영자 승인 전까지 자동 전송되지 않습니다.)`,
  '개인정보 포함': () =>
    `안녕하세요, 고객님. 문의 감사합니다.\n` +
    `개인정보(연락처/이메일 등)는 안전을 위해 별도 채널로 처리됩니다.\n` +
    `운영자가 직접 확인 후 등록된 채널로 연락드리겠습니다.`,
  '기타': () =>
    `안녕하세요, 고객님. 문의 주셔서 감사합니다.\n` +
    `정확한 내용을 확인한 뒤 안내드리겠습니다. 추가로 필요한 정보가 있다면 함께 알려주시면 감사하겠습니다.`,
};

const MAX_LEN = 1000;
function clamp(text) {
  if (text.length <= MAX_LEN) return text;
  return text.slice(0, MAX_LEN - 3) + '...';
}

export function templateDraft({ inquiry, category }) {
  const tplFn = TEMPLATES[category] || TEMPLATES['기타'];
  const product = inquiry?.productName || inquiry?.product_name;
  return { draft: clamp(tplFn(product)) };
}

export class RuleBasedProvider {
  constructor() {
    this.id = 'rule-based';
  }
  async classify(message) {
    return ruleClassify(message);
  }
  async generateDraft({ inquiry, category }) {
    return templateDraft({ inquiry, category });
  }
  async healthCheck() {
    return { ok: true, version: 'rule-based (built-in)' };
  }
}

export const ALLOWED_CATEGORIES = [
  '배송 지연', '상품 정보 문의', '교환/반품', '환불', '파손/누락',
  '불량', '사용법 문의', '화난 고객', '법적/분쟁 위험', '개인정보 포함', '기타',
];

export const ALLOWED_FLAGS = [
  'LEGAL_THREAT', 'PRIVACY_EXPOSURE', 'RUDE_LANGUAGE',
  'UNKNOWN_ORDER_STATUS', 'MANUAL_REVIEW_REQUIRED',
];
