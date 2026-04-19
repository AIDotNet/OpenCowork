import type { ProviderConfig } from './types'

export const RESPONSES_SESSION_SCOPE_MAIN = 'main'
export const RESPONSES_SESSION_SCOPE_AGENT_MAIN = 'agent-main'
export const RESPONSES_SESSION_SCOPE_PROMPT_RECOMMENDATION = 'prompt-recommendation'
export const RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION = 'context-compression'
export const RESPONSES_SESSION_SCOPE_GENERATE_TITLE = 'generate-title'
export const RESPONSES_SESSION_SCOPE_AUTO_MODEL_ROUTING = 'auto-model-routing'
export const RESPONSES_SESSION_SCOPE_SIDECAR_TEXT_REQUEST = 'sidecar-text-request'

export function withResponsesSessionScope(config: ProviderConfig, scope: string): ProviderConfig {
  if (config.type !== 'openai-responses') {
    return config
  }

  return {
    ...config,
    responsesSessionScope: scope
  }
}

export function withAuxiliaryResponsesRequestPolicy(
  config: ProviderConfig,
  scope: string
): ProviderConfig {
  if (config.type !== 'openai-responses') {
    return config
  }

  return {
    ...config,
    responsesSessionScope: scope,
    websocketMode: 'disabled'
  }
}
