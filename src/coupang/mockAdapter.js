import fs from 'node:fs';
import path from 'node:path';
import { GNET_DIR } from '../config.js';
import { logger } from '../logger.js';

const MOCK_PATH = path.join(GNET_DIR, 'mock-inquiries.json');

export class MockCoupangAdapter {
  constructor(config) {
    this.config = config;
    this._extraInquiries = [];
  }

  getMode() {
    return 'mock';
  }

  async listInquiries() {
    let base = [];
    if (fs.existsSync(MOCK_PATH)) {
      try {
        base = JSON.parse(fs.readFileSync(MOCK_PATH, 'utf-8'));
      } catch (err) {
        logger.warn('mock-inquiries.json 파싱 실패', { error: err.message });
      }
    }
    return [...base, ...this._extraInquiries];
  }

  async sendReply({ coupangInquiryId, message }) {
    // mock: 항상 성공으로 처리, 실제 호출하지 않음
    logger.info('Mock 답변 전송', {
      coupangInquiryId,
      messageLength: message?.length || 0,
    });
    return { ok: true, mock: true };
  }

  // Test helper: 새 문의를 시뮬레이트하고 싶을 때
  injectInquiry(raw) {
    this._extraInquiries.push(raw);
  }
}
