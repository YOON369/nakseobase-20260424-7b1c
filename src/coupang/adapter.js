/**
 * Coupang Adapter 인터페이스
 *
 * 모든 Adapter 구현체는 다음 메서드를 갖춰야 한다:
 *
 *   getMode(): 'mock' | 'real'
 *
 *   async listInquiries({ sinceIso? }): Promise<RawInquiry[]>
 *     - 쿠팡에서 새 문의를 가져온다.
 *
 *   async sendReply({ coupangInquiryId, message }):
 *     Promise<{ ok: boolean, mock?: boolean, error?: string, code?: string }>
 *     - 쿠팡에 답변을 전송한다.
 *
 * RawInquiry 형태:
 *   {
 *     coupangInquiryId: string,
 *     sourceType: 'customer' | 'product',
 *     productName: string,
 *     orderId: string | null,
 *     customerMessage: string,
 *     receivedAt: ISO8601 string
 *   }
 */

import { MockCoupangAdapter } from './mockAdapter.js';
import { RealCoupangAdapter } from './realAdapter.js';

export function createAdapter(config) {
  const mode = config.mode === 'real' && config.coupang?.apiEnabled ? 'real' : 'mock';
  if (mode === 'real') return new RealCoupangAdapter(config);
  return new MockCoupangAdapter(config);
}
