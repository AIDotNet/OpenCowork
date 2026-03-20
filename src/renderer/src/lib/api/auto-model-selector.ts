import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { useProviderStore } from '@renderer/stores/provider-store'
import type { AutoModelSelectionStatus } from '@renderer/stores/ui-store'
import { createProvider } from './provider'
import type { ProviderConfig, UnifiedMessage } from './types'

const AUTO_MODEL_SELECTOR_PROMPT = [
  'You are a strict model router.',
  'Decide whether the latest user input should use the main model or the fast model.',
  'Return ONLY one token: main or fast.',
  'Choose main for complex reasoning, multi-step coding/debugging, architecture, long analysis, or ambiguous tasks that likely need deeper thinking.',
  'Choose fast for simple Q&A, short rewrites, lightweight summaries, quick formatting, or other straightforward requests.',
  'Never output anything except main or fast.'
].join(' ')

function stripRoutingArtifacts(value: string): string {
  return value
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<system-command\b[^>]*>[\s\S]*?<\/system-command>/gi, '')
    .trim()
}

function extractTextContent(content: UnifiedMessage['content']): string {
  if (typeof content === 'string') {
    return stripRoutingArtifacts(content)
  }

  return stripRoutingArtifacts(
    content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  )
}

export function extractLatestUserInput(messages: UnifiedMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = extractTextContent(message.content)
    if (text) return text
  }
  return ''
}

function resolveDescriptor(
  config: ProviderConfig | null
): Pick<AutoModelSelectionStatus, 'providerId' | 'modelId' | 'providerName' | 'modelName'> {
  if (!config?.providerId || !config.model) {
    return {
      providerId: config?.providerId,
      modelId: config?.model,
      providerName: undefined,
      modelName: config?.model
    }
  }

  const provider = useProviderStore
    .getState()
    .providers.find((item) => item.id === config.providerId)
  const model = provider?.models.find((item) => item.id === config.model)

  return {
    providerId: config.providerId,
    modelId: config.model,
    providerName: provider?.name,
    modelName: model?.name ?? config.model
  }
}

function buildSelectionStatus(
  target: AutoModelSelectionStatus['target'],
  config: ProviderConfig | null,
  fallbackReason?: string
): AutoModelSelectionStatus {
  return {
    source: 'auto',
    target,
    ...resolveDescriptor(config),
    ...(fallbackReason ? { fallbackReason } : {}),
    selectedAt: Date.now()
  }
}

function normalizeRoute(value: string): 'main' | 'fast' | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'main' || normalized === 'fast') return normalized
  const matched = normalized.match(/\b(main|fast)\b/)
  if (matched?.[1] === 'main') return 'main'
  if (matched?.[1] === 'fast') return 'fast'
  return null
}

function getFastModelSupportsTools(): boolean {
  const fastConfig = useProviderStore.getState().getFastProviderConfig()
  if (!fastConfig?.providerId || !fastConfig.model) return false
  const provider = useProviderStore
    .getState()
    .providers.find((item) => item.id === fastConfig.providerId)
  const model = provider?.models.find((item) => item.id === fastConfig.model)
  return model?.supportsFunctionCall !== false
}

export async function selectAutoModel(options: {
  latestUserInput: string
  allowTools?: boolean
  signal?: AbortSignal
}): Promise<AutoModelSelectionStatus> {
  const providerStore = useProviderStore.getState()
  const mainConfig = providerStore.getActiveProviderConfig()
  const fastConfig = providerStore.getFastProviderConfig()
  const latestUserInput = options.latestUserInput.trim()

  if (!mainConfig) {
    return buildSelectionStatus('main', null, 'main_unavailable')
  }

  if (!latestUserInput) {
    return buildSelectionStatus('main', mainConfig, 'empty_input')
  }

  if (!fastConfig) {
    return buildSelectionStatus('main', mainConfig, 'fast_unavailable')
  }

  if (options.allowTools && !getFastModelSupportsTools()) {
    return buildSelectionStatus('main', mainConfig, 'fast_model_tools_unsupported')
  }

  if (fastConfig.requiresApiKey !== false && !fastConfig.apiKey) {
    return buildSelectionStatus('main', mainConfig, 'fast_auth_missing')
  }

  if (fastConfig.providerId) {
    const fastReady = await ensureProviderAuthReady(fastConfig.providerId)
    if (!fastReady) {
      return buildSelectionStatus('main', mainConfig, 'fast_auth_unavailable')
    }
  }

  const abortController = new AbortController()
  const abort = (): void => abortController.abort()
  const timeout = setTimeout(abort, 10000)
  options.signal?.addEventListener('abort', abort, { once: true })

  try {
    const routingConfig: ProviderConfig = {
      ...fastConfig,
      maxTokens: 8,
      temperature: 0,
      thinkingEnabled: false,
      systemPrompt: AUTO_MODEL_SELECTOR_PROMPT
    }

    const provider = createProvider(routingConfig)
    const messages: UnifiedMessage[] = [
      {
        id: 'auto-model-route',
        role: 'user',
        content: latestUserInput.slice(0, 4000),
        createdAt: Date.now()
      }
    ]

    let output = ''
    for await (const event of provider.sendMessage(
      messages,
      [],
      routingConfig,
      abortController.signal
    )) {
      if (event.type === 'text_delta' && event.text) {
        output += event.text
        if (output.length >= 32) break
      }
    }

    const target = normalizeRoute(stripRoutingArtifacts(output))
    if (!target) {
      return buildSelectionStatus('main', mainConfig, 'invalid_classifier_output')
    }

    return target === 'fast'
      ? buildSelectionStatus('fast', fastConfig)
      : buildSelectionStatus('main', mainConfig)
  } catch {
    return buildSelectionStatus('main', mainConfig, 'classification_failed')
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
