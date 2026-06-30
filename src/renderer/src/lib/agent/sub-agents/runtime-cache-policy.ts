import type { ProviderConfig } from '../../api/types'
import { OPENAI_RESPONSES_SUB_AGENT_SCOPE_PREFIX } from '../../../../../shared/openai-responses-session'

function normalizeCacheSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return normalized || fallback
}

function mergeRequestBodyOverride(
  config: ProviderConfig,
  bodyPatch: Record<string, unknown>
): ProviderConfig {
  return {
    ...config,
    requestOverrides: {
      ...(config.requestOverrides ?? {}),
      body: {
        ...(config.requestOverrides?.body ?? {}),
        ...bodyPatch
      }
    }
  }
}

function shouldSetPromptCacheKey(config: ProviderConfig): boolean {
  if (config.type !== 'openai-chat' && config.type !== 'openai-responses') return false
  const existing = config.requestOverrides?.body?.prompt_cache_key
  return typeof existing !== 'string' || !existing.trim()
}

export function withSubAgentRuntimeCachePolicy(
  config: ProviderConfig,
  options: {
    agentName: string
    sessionId?: string | null
    runScopeId?: string | null
  }
): ProviderConfig {
  const agentSegment = normalizeCacheSegment(options.agentName, 'agent')
  const sessionSegment = normalizeCacheSegment(options.sessionId, 'global')
  const runSegment = normalizeCacheSegment(options.runScopeId, agentSegment)
  let next = config

  if (next.type === 'openai-responses') {
    next = {
      ...next,
      responsesSessionScope: `${OPENAI_RESPONSES_SUB_AGENT_SCOPE_PREFIX}:${runSegment}`
    }
  }

  if (shouldSetPromptCacheKey(next)) {
    next = mergeRequestBodyOverride(next, {
      prompt_cache_key: `opencowork-${sessionSegment}-subagent-${agentSegment}`
    })
  }

  return next
}
