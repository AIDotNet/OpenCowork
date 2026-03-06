import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { createProvider } from './provider'
import type { ProviderConfig, UnifiedMessage } from './types'
import { SESSION_ICONS_PROMPT_LIST } from '@renderer/lib/constants/session-icons'

export interface SessionTitleResult {
  title: string
  icon: string
}

export type FriendlyStatus = 'idle' | 'pending' | 'error' | 'streaming' | 'agents' | 'background'

const FRIENDLY_MESSAGES: Record<FriendlyStatus, { zh: string[]; en: string[] }> = {
  idle: {
    zh: [
      '随时准备为你效劳',
      '有什么想法，尽管说',
      '今天也是元气满满的一天',
      '准备就绪，等你发令',
      '万事俱备，只欠你开口',
      '灵感来了就别犹豫',
      '你的专属助手已上线',
      '静候佳音',
    ],
    en: [
      'Ready when you are',
      'What shall we build today?',
      'Standing by for your ideas',
      'All systems go',
      'Your assistant is ready',
      'Inspiration awaits',
      'Let\'s get things done',
      'At your service',
    ],
  },
  streaming: {
    zh: [
      '思考中，请稍候',
      '正在组织回答',
      '全力运转中',
      '马上就好',
      '正在为你解答',
      '灵感涌来中',
    ],
    en: [
      'Thinking...',
      'Working on it',
      'Almost there',
      'Processing your request',
      'Crafting a response',
      'On it',
    ],
  },
  pending: {
    zh: [
      '等待你的确认',
      '需要你看一下',
      '请审批操作',
      '操作待确认',
    ],
    en: [
      'Waiting for your approval',
      'Action needs confirmation',
      'Please review',
      'Approval needed',
    ],
  },
  error: {
    zh: [
      '遇到了一点问题',
      '出了点小状况',
      '别担心，我们来看看',
      '需要你关注一下',
    ],
    en: [
      'Something went wrong',
      'Hit a snag',
      'Let\'s take a look',
      'Needs your attention',
    ],
  },
  agents: {
    zh: [
      '子任务进行中',
      '团队协作中',
      '多个助手协同工作中',
      '正在并行处理',
    ],
    en: [
      'Sub-agents at work',
      'Team is collaborating',
      'Working in parallel',
      'Agents are on it',
    ],
  },
  background: {
    zh: [
      '后台任务运行中',
      '命令执行中',
      '后台进程工作中',
    ],
    en: [
      'Background tasks running',
      'Commands in progress',
      'Working in the background',
    ],
  },
}

let lastPickIndex: Record<string, number> = {}

export function pickFriendlyMessage(status: FriendlyStatus, language: 'zh' | 'en'): string {
  const pool = FRIENDLY_MESSAGES[status]?.[language] ?? FRIENDLY_MESSAGES.idle[language]
  const key = `${status}_${language}`
  const prevIdx = lastPickIndex[key] ?? -1
  let idx = Math.floor(Math.random() * pool.length)
  if (pool.length > 1 && idx === prevIdx) idx = (idx + 1) % pool.length
  lastPickIndex[key] = idx
  return pool[idx]
}

const stripReasoningBlocks = (value: string): string =>
  value
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<\/think>/gi, '')

const stripMarkdown = (value: string): string =>
  value
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')

const looksLikeReasoning = (value: string): boolean => {
  const markers = [
    /思考过程/,
    /分析.*指令/,
    /\*\*目标\*\*/,
    /步骤\s*\d/,
    /^(?:\d+\.\s)/m,
    /^\s*[-*]\s+\*\*/m,
  ]
  return markers.filter((r) => r.test(value)).length >= 2
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

  if (!config || (config.requiresApiKey !== false && !config.apiKey)) return null

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

    if (looksLikeReasoning(title)) return null

    const cleaned = stripReasoningBlocks(title)
      .replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1')
      .trim()
    if (!cleaned) return null

    try {
      const jsonMatch = cleaned.match(/\{[^{}]*"title"\s*:\s*"[^"]*"[^{}]*\}/)
        ?? cleaned.match(/\{[\s\S]*?\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        if (parsed.title && parsed.icon) {
          let t = stripMarkdown(stripReasoningBlocks(String(parsed.title)))
            .replace(/^["']|["']$/g, '')
            .replace(/\n+/g, ' ')
            .trim()
          if (t.length > 40) t = t.slice(0, 40) + '...'
          return { title: t, icon: String(parsed.icon).trim() }
        }
      }
    } catch { /* fall through to plain-text fallback */ }

    let plainTitle = stripMarkdown(stripReasoningBlocks(cleaned))
      .replace(/^["']|["']$/g, '')
      .replace(/[{}]/g, '')
      .replace(/\n+/g, ' ')
      .trim()
    if (plainTitle.length > 40) plainTitle = plainTitle.slice(0, 40) + '...'
    return { title: plainTitle, icon: 'message-square' }
  } catch {
    return null
  }
}
