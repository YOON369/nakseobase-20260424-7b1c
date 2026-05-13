import { getProvider } from './llm/provider.js';
import { templateDraft } from './llm/ruleProvider.js';
import { logger } from '../logger.js';

/**
 * 답변 초안을 생성한다.
 *
 *   generateDraft({ inquiry, review }, config) → { draft }
 *
 * config.ai.provider 가 'claude-cli'면 사용자의 로컬 claude CLI로 호출,
 * 실패 시 카테고리별 한국어 템플릿으로 폴백.
 */
export async function generateDraft({ inquiry, review }, config) {
  const category = review?.category || '기타';
  const provider = getProvider(config);
  if (provider.id === 'rule-based') {
    return templateDraft({ inquiry, category });
  }
  try {
    return await provider.generateDraft({ inquiry, category });
  } catch (err) {
    if (config?.ai?.fallbackToRules === false) {
      throw err;
    }
    logger.warn('LLM generateDraft 실패 → 템플릿 폴백', {
      provider: provider.id,
      error: err.message,
    });
    return templateDraft({ inquiry, category });
  }
}
