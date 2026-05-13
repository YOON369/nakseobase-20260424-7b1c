// 로컬에 설치된 claude CLI(Claude Code, 사용자 구독)와의 연결을 점검한다.
// 사용: npm run check:claude
import { loadConfig } from '../config.js';
import { getProvider } from '../ai/llm/provider.js';

const baseConfig = loadConfig();
const config = {
  ...baseConfig,
  ai: { ...(baseConfig.ai || {}), provider: 'claude-cli' },
};
const provider = getProvider(config);

try {
  const r = await provider.healthCheck();
  console.log(`OK · claude CLI 연결됨 → ${r.version}`);
  console.log('  - 분류/답변은 사용자의 Claude 구독을 통해 실행됩니다.');
  process.exit(0);
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  console.error('');
  console.error('점검 절차:');
  console.error('  1. claude CLI 설치  →  npm install -g @anthropic-ai/claude-code');
  console.error('  2. 한 번 직접 실행해 로그인  →  claude  (구독 계정으로 OAuth)');
  console.error('  3. PATH 확인  →  which claude');
  console.error('  4. config.ai.claudeCli.binary 경로가 올바른지 확인');
  process.exit(1);
}
