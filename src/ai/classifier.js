/**
 * Rule-based classifier (한국어).
 * 나중에 LLM(OpenAI / Claude / 로컬 모델)로 교체할 수 있도록 단순 인터페이스 유지.
 *
 *   classify(message): {
 *     category: string,
 *     sentiment: 'positive' | 'neutral' | 'negative' | 'angry',
 *     riskLevel: 'low' | 'medium' | 'high',
 *     safetyFlags: string[],
 *     confidence: number  // 0..1
 *   }
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

export function classify(rawMessage) {
  const message = rawMessage || '';
  const flags = [];
  const scored = CATEGORIES.map((c) => ({ id: c.id, score: matchScore(message, c.keywords) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  let category = top.score > 0 ? top.id : '기타';

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
    // separately mark angry/refund coercion as policy boundary
  }
  if (category === '배송 지연') flags.push('UNKNOWN_ORDER_STATUS');

  if (legalHits > 0 || refundThreat || hasPrivacy) flags.push('MANUAL_REVIEW_REQUIRED');

  // 카테고리가 환불/파손/불량이면 분쟁 가능성 알림 (자동 약속 방지)
  if (['환불', '파손/누락', '불량'].includes(category)) {
    if (!flags.includes('MANUAL_REVIEW_REQUIRED')) flags.push('MANUAL_REVIEW_REQUIRED');
  }

  // confidence: 매우 단순한 휴리스틱 — top 카테고리 점수 기반
  const totalScore = scored.reduce((sum, c) => sum + c.score, 0);
  const confidence = top.score > 0 && totalScore > 0
    ? Math.min(0.95, 0.5 + top.score / (totalScore + 1) * 0.5)
    : 0.3;

  return {
    category,
    sentiment,
    riskLevel,
    safetyFlags: Array.from(new Set(flags)),
    confidence: Number(confidence.toFixed(2)),
  };
}
