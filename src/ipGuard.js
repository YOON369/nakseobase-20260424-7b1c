import { logger } from './logger.js';
import { ipGuardLogsDao } from './db.js';

/**
 * IP Guard
 *
 *  - 현재 공인 IP를 외부 서비스로 조회
 *  - registeredIp와 비교
 *  - 결과를 메모리/DB에 저장
 *  - blocked 상태에서는 isApiAllowed()가 false 반환
 *
 *  ipify.org는 외부 서비스이므로 실패할 수 있음 → status: 'UNKNOWN'으로 처리.
 */

const IPIFY_URL = 'https://api.ipify.org?format=json';
const FETCH_TIMEOUT_MS = 5000;

let lastStatus = {
  status: 'UNKNOWN',
  registeredIp: null,
  currentIp: null,
  checkedAt: null,
  errorMessage: '아직 점검되지 않음',
};

async function fetchPublicIp() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(IPIFY_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.ip;
  } finally {
    clearTimeout(t);
  }
}

export async function checkIpGuard(config) {
  const registered = (config?.coupang?.registeredIp || '').trim();
  const checkedAt = new Date().toISOString();

  let currentIp = null;
  let status = 'UNKNOWN';
  let errorMessage = null;

  try {
    currentIp = await fetchPublicIp();
  } catch (err) {
    errorMessage = `공인 IP 조회 실패: ${err.message}`;
    logger.warn(errorMessage);
  }

  if (!registered) {
    status = 'UNKNOWN';
    errorMessage = errorMessage || 'registeredIp가 설정되지 않았습니다. config.json에서 등록하세요.';
  } else if (!currentIp) {
    status = 'UNKNOWN';
  } else if (currentIp === registered) {
    status = 'OK';
    errorMessage = null;
  } else {
    status = 'BLOCKED';
    errorMessage = `현재 공인 IP(${currentIp})가 등록된 쿠팡 OpenAPI IP(${registered})와 다릅니다. Coupang Wing에서 IP를 갱신하거나 고정 IP를 사용하세요.`;
  }

  lastStatus = {
    status,
    registeredIp: registered || null,
    currentIp: currentIp || null,
    checkedAt,
    errorMessage,
  };

  try {
    ipGuardLogsDao.insert({
      registeredIp: registered || null,
      currentIp: currentIp || null,
      status,
      errorMessage,
    });
  } catch (err) {
    logger.warn('ip_guard_logs 기록 실패', { error: err.message });
  }

  if (status === 'BLOCKED') {
    logger.warn('IP Guard BLOCKED', { registeredIp: registered, currentIp });
  } else {
    logger.info(`IP Guard ${status}`, { registeredIp: registered, currentIp });
  }
  return lastStatus;
}

export function getLastStatus() {
  return lastStatus;
}

export function isApiAllowed(config) {
  if (config?.mode !== 'real') return true; // mock 모드는 IP Guard 무관하게 허용
  if (!config?.coupang?.apiEnabled) return false;
  return lastStatus.status === 'OK';
}

export function classifyApiError(err) {
  // 쿠팡 API에서 403 등 IP 차단 응답이 오면 감지
  const msg = (err?.message || '').toLowerCase();
  if (/not allowed ip|forbidden|403/.test(msg)) {
    return 'IP_NOT_ALLOWED';
  }
  return null;
}
