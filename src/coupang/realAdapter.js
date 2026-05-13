import { logger } from '../logger.js';

/**
 * 실제 Coupang OpenAPI 어댑터 (스텁).
 *
 * MVP에서는 실제 호출이 비활성화되어 있다. 아래 메서드들은 명시적으로 NotImplemented를 던진다.
 * 실제 연결 시 구현해야 할 내용:
 *
 * 1. HMAC 서명 생성 (Coupang Wing OpenAPI signature)
 *    - accessKey, secretKey, datetime, method, path, query
 * 2. listInquiries: GET /v2/providers/openapi/apis/api/v4/vendors/{vendorId}/...
 *    (정확한 엔드포인트는 Coupang Wing 문서 확인 후 확정. MVP에서는 임의 확정 금지)
 * 3. sendReply: 답변 전송 엔드포인트 호출 (역시 문서 확인)
 * 4. 응답을 RawInquiry 스키마로 정규화
 * 5. 403 / IP not allowed 류 응답을 감지해 IP Guard에 신호
 */

const NOT_IMPLEMENTED_MSG =
  '실제 Coupang OpenAPI 어댑터는 아직 구현되지 않았습니다. config.mode를 "mock"으로 두거나, src/coupang/realAdapter.js를 완성하세요.';

export class RealCoupangAdapter {
  constructor(config) {
    this.config = config;
    logger.warn('RealCoupangAdapter가 인스턴스화되었습니다. 호출 시 NotImplemented가 발생합니다.');
  }

  getMode() {
    return 'real';
  }

  async listInquiries() {
    throw new Error(NOT_IMPLEMENTED_MSG);
  }

  async sendReply() {
    throw new Error(NOT_IMPLEMENTED_MSG);
  }
}
