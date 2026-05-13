import { getProvider } from './llm/provider.js';
import { ruleClassify } from './llm/ruleProvider.js';
import { logger } from '../logger.js';

/**
 * 문의 메시지를 분류한다.
 *
 *   classify(message, config) → {
 *     category, sentiment, riskLevel, safetyFlags, confidence
 *   }
 *
 * config.ai.provider 가 'claude-cli'면 사용자의 로컬 claude CLI(=구독)로 호출하고,
 * 실패하면 rule-based 폴백 (config.ai.fallbackToRules !== false).
 */
export async function classify(message, config) {
  const provider = getProvider(config);
  if (provider.id === 'rule-based') {
    return ruleClassify(message);
  }
  try {
    return await provider.classify(message);
  } catch (err) {
    if (config?.ai?.fallbackToRules === false) {
      throw err;
    }
    logger.warn('LLM classify 실패 → rule-based 폴백', {
      provider: provider.id,
      error: err.message,
    });
    return ruleClassify(message);
  }
}
