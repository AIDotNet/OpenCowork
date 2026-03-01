import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { createProvider } from './provider'
import type { ProviderConfig, UnifiedMessage } from './types'
import { SESSION_ICONS_PROMPT_LIST } from '@renderer/lib/constants/session-icons'

export interface SessionTitleResult {
  title: string
  icon: string
}

export interface FriendlyMessageParams {
  language: 'zh' | 'en'
  status: 'idle' | 'pending' | 'error' | 'streaming' | 'agents' | 'background'
  detail?: string
}

const stripReasoningBlocks = (value: string): string =>
  value
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<\/think>/gi, '')

const FRIENDLY_SYSTEM_PROMPT = `You generate a single friendly sentence for the app title bar.
Rules:
- Output ONE sentence only, no lists, no quotes, no emojis, no markdown.
- Keep it short: 8 to 18 Chinese characters or 6 to 12 English words.
- Tone: encouraging, warm, and slightly witty. You may use a short proverb or a light saying.
- Context is provided as a status string; reflect it subtly if possible.
- Do NOT mention models, providers, or system internals.
- Output plain text only.`

export async function generateFriendlyMessage(
  params: FriendlyMessageParams
): Promise<string | null> {
  const settings = useSettingsStore.getState()

  const fastConfig = useProviderStore.getState().getFastProviderConfig()
  const config: ProviderConfig | null = fastConfig
    ? {
        ...fastConfig,
        maxTokens: 60,
        temperature: 0.6,
        systemPrompt: FRIENDLY_SYSTEM_PROMPT,
        responseSummary: useProviderStore.getState().getActiveModelConfig()?.responseSummary,
        enablePromptCache: useProviderStore.getState().getActiveModelConfig()?.enablePromptCache,
        enableSystemPromptCache: useProviderStore.getState().getActiveModelConfig()?.enableSystemPromptCache
      }
    : settings.apiKey && settings.fastModel
      ? {
          type: settings.provider,
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl || undefined,
          model: settings.fastModel,
          maxTokens: 60,
          temperature: 0.6,
          systemPrompt: FRIENDLY_SYSTEM_PROMPT,
          responseSummary: useProviderStore.getState().getActiveModelConfig()?.responseSummary,
          enablePromptCache: useProviderStore.getState().getActiveModelConfig()?.enablePromptCache,
          enableSystemPromptCache: useProviderStore.getState().getActiveModelConfig()?.enableSystemPromptCache
        }
      : null

  if (!config || (config.requiresApiKey !== false && !config.apiKey)) return null

  const statusLine = `status=${params.status}${params.detail ? `; ${params.detail}` : ''}`
  const languageLine = params.language === 'zh' ? 'language=zh' : 'language=en'

  const messages: UnifiedMessage[] = [
    {
      id: 'friendly-req',
      role: 'user',
      content: `${languageLine}; ${statusLine}`,
      createdAt: Date.now()
    }
  ]

  try {
    const provider = createProvider(config)
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), 12000)

    let text = ''
    for await (const event of provider.sendMessage(messages, [], config, abortController.signal)) {
      if (event.type === 'text_delta' && event.text) {
        text += event.text
      }
    }
    clearTimeout(timeout)

    const cleaned = stripReasoningBlocks(text)
      .replace(/```[\s\S]*?```/g, '')
      .trim()
    if (!cleaned) return null

    return cleaned.replace(/^"|"$/g, '').trim()
  } catch {
    return null
  }
}

const TITLE_SYSTEM_PROMPT = `You are a title generator. Given a user message, produce:
1. A concise title (max 30 characters) that summarizes the intent.
2. Pick ONE icon name from the following Lucide icon list that best represents the topic:
${SESSION_ICONS_PROMPT_LIST}

Reply with ONLY a JSON object in this exact format (no markdown, no explanation):
{"title":"your title here","icon":"icon-name"}`

/**
 * Use the fast model to generate a short session title from the user's first message.
 * Runs in the background — does not block the main chat flow.
 * Returns { title, icon } or null on failure.
 */
export async function generateSessionTitle(userMessage: string): Promise<SessionTitleResult | null> {
  const settings = useSettingsStore.getState()

  // Try provider-store fast model config first, then fall back to settings-store
  const fastConfig = useProviderStore.getState().getFastProviderConfig()
  const config: ProviderConfig | null = fastConfig
    ? {
        ...fastConfig,
        maxTokens: 100,
        temperature: 0.3,
        systemPrompt: TITLE_SYSTEM_PROMPT,
        responseSummary: useProviderStore.getState().getActiveModelConfig()?.responseSummary,
        enablePromptCache: useProviderStore.getState().getActiveModelConfig()?.enablePromptCache,
        enableSystemPromptCache: useProviderStore.getState().getActiveModelConfig()?.enableSystemPromptCache,
      }
    : settings.apiKey && settings.fastModel
      ? {
          type: settings.provider,
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl || undefined,
          model: settings.fastModel,
          maxTokens: 100,
          temperature: 0.3,
          systemPrompt: TITLE_SYSTEM_PROMPT,
          responseSummary: useProviderStore.getState().getActiveModelConfig()?.responseSummary,
          enablePromptCache: useProviderStore.getState().getActiveModelConfig()?.enablePromptCache,
          enableSystemPromptCache: useProviderStore.getState().getActiveModelConfig()?.enableSystemPromptCache,
        }
      : null

  if (!config || !config.apiKey) return null

  const messages: UnifiedMessage[] = [
    {
      id: 'title-req',
      role: 'user',
      content: userMessage.slice(0, 500),
      createdAt: Date.now(),
    },
  ]

  try {
    const provider = createProvider(config)
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), 15000)

    let title = ''
    for await (const event of provider.sendMessage(messages, [], config, abortController.signal)) {
      if (event.type === 'text_delta' && event.text) {
        title += event.text
      }
    }
    clearTimeout(timeout)

    // Strip thinking tags, markdown fences, and surrounding whitespace
    const cleaned = stripReasoningBlocks(title)
      .replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1')
      .trim()
    if (!cleaned) return null

    // Try to parse JSON response — use a non-greedy match scoped to a single object
    try {
      const jsonMatch = cleaned.match(/\{[^{}]*"title"\s*:\s*"[^"]*"[^{}]*\}/)
        ?? cleaned.match(/\{[\s\S]*?\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        if (parsed.title && parsed.icon) {
          let t = stripReasoningBlocks(String(parsed.title)).trim().replace(/^["']|["']$/g, '').trim()
          if (t.length > 40) t = t.slice(0, 40) + '...'
          return { title: t, icon: String(parsed.icon).trim() }
        }
      }
    } catch { /* fall through to plain-text fallback */ }

    // Fallback: treat entire response as title, use default icon
    let plainTitle = stripReasoningBlocks(cleaned).replace(/^["']|["']$/g, '').replace(/[{}]/g, '').trim()
    if (plainTitle.length > 40) plainTitle = plainTitle.slice(0, 40) + '...'
    return { title: plainTitle, icon: 'message-square' }
  } catch {
    return null
  }
}
