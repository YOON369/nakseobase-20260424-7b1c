import { RuleBasedProvider } from './ruleProvider.js';
import { ClaudeCliProvider } from './claudeCliProvider.js';

/**
 * AI provider 팩토리. 매 호출 시 인스턴스를 새로 만든다(설정 변경 즉시 반영).
 *
 *   getProvider(config) → Provider
 *
 * Provider:
 *   id: 'rule-based' | 'claude-cli'
 *   async classify(message)
 *   async generateDraft({ inquiry, category })
 *   async healthCheck()
 */
export function getProvider(config) {
  const id = config?.ai?.provider || 'rule-based';
  if (id === 'claude-cli') {
    return new ClaudeCliProvider(config.ai?.claudeCli || {});
  }
  return new RuleBasedProvider();
}

export function listProviders() {
  return ['rule-based', 'claude-cli'];
}
