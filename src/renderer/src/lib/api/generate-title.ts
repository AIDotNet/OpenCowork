import { useProviderStore } from '@renderer/stores/provider-store'
import type { ProviderConfig, UnifiedMessage } from './types'
import { createProvider } from './provider'

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
      '静候佳音'
    ],
    en: [
      'Ready when you are',
      'What shall we build today?',
      'Standing by for your ideas',
      'All systems go',
      'Your assistant is ready',
      'Inspiration awaits',
      "Let's get things done",
      'At your service'
    ]
  },
  streaming: {
    zh: ['思考中，请稍候', '正在组织回答', '全力运转中', '马上就好', '正在为你解答', '灵感涌来中'],
    en: [
      'Thinking...',
      'Working on it',
      'Almost there',
      'Processing your request',
      'Crafting a response',
      'On it'
    ]
  },
  pending: {
    zh: ['等待你的确认', '需要你看一下', '请审批操作', '操作待确认'],
    en: [
      'Waiting for your approval',
      'Action needs confirmation',
      'Please review',
      'Approval needed'
    ]
  },
  error: {
    zh: ['遇到了一点问题', '出了点小状况', '别担心，我们来看看', '需要你关注一下'],
    en: ['Something went wrong', 'Hit a snag', "Let's take a look", 'Needs your attention']
  },
  agents: {
    zh: ['子任务进行中', '团队协作中', '多个助手协同工作中', '正在并行处理'],
    en: ['Sub-agents at work', 'Team is collaborating', 'Working in parallel', 'Agents are on it']
  },
  background: {
    zh: ['后台任务运行中', '命令执行中', '后台进程工作中'],
    en: ['Background tasks running', 'Commands in progress', 'Working in the background']
  }
}

const lastPickIndex: Record<string, number> = {}

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
  value.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').replace(/<\/think>/gi, '')

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
    /^\s*[-*]\s+\*\*/m
  ]
  return markers.filter((r) => r.test(value)).length >= 2
}

const TITLE_SYSTEM_PROMPT =
  'You are only a chat-title generator. Never answer or fulfill the user message. Return only JSON.'

function buildTitlePrompt(userMessage: string, maxInputChars: number): string {
  return `Create a concise chat title for this user message. Do not answer the message.

USER_MESSAGE:
"""
${userMessage.slice(0, maxInputChars)}
"""

Return only JSON: {"title":"Short Title"}`
}

function isUsableProviderConfig(config: ProviderConfig | null): config is ProviderConfig {
  return Boolean(config && (config.requiresApiKey === false || config.apiKey))
}

function withTitleRequestDefaults(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    maxTokens: 500,
    temperature: 0.2,
    systemPrompt: TITLE_SYSTEM_PROMPT,
    thinkingEnabled: false,
    thinkingConfig: undefined,
    reasoningEffort: undefined,
    responseSummary: undefined,
    websocketMode: 'disabled'
  }
}

async function requestOpenAIChatTitle(
  config: ProviderConfig,
  userMessage: string,
  maxInputChars: number
): Promise<SessionTitleResult | null> {
  const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`
  }
  if (config.userAgent) headers['User-Agent'] = config.userAgent
  if (config.serviceTier) headers.service_tier = config.serviceTier

  const response = (await window.electron.ipcRenderer.invoke('api:request', {
    url: `${baseUrl}/chat/completions`,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: buildTitlePrompt(userMessage, maxInputChars) }
      ],
      stream: false,
      max_tokens: 500,
      temperature: 0.2
    }),
    useSystemProxy: config.useSystemProxy,
    allowInsecureTls: config.allowInsecureTls ?? true,
    providerId: config.providerId,
    providerBuiltinId: config.providerBuiltinId
  })) as { statusCode?: number; body?: string; error?: string }

  if (response.error || !response.body || (response.statusCode ?? 0) >= 400) {
    console.warn('[AutoTitle] title request failed', {
      statusCode: response.statusCode,
      error: response.error
    })
    return null
  }

  try {
    const parsed = JSON.parse(response.body) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return parseSessionTitleResponse(parsed.choices?.[0]?.message?.content ?? '')
  } catch (error) {
    console.warn('[AutoTitle] failed to parse title response', error)
    return null
  }
}

function parseSessionTitleResponse(response: string): SessionTitleResult | null {
  if (looksLikeReasoning(response)) return null

  const cleaned = stripReasoningBlocks(response)
    .replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1')
    .trim()
  if (!cleaned) return null

  try {
    const jsonMatch =
      cleaned.match(/\{[^{}]*"title"\s*:\s*"[^"]*"[^{}]*\}/) ?? cleaned.match(/\{[\s\S]*?\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.title) {
        let title = stripMarkdown(stripReasoningBlocks(String(parsed.title)))
          .replace(/^["']|["']$/g, '')
          .replace(/\n+/g, ' ')
          .trim()
        if (title.length > 40) title = title.slice(0, 40) + '...'
        return { title, icon: String(parsed.icon ?? 'message-square').trim() }
      }
    }
  } catch {
    /* fall through to plain-text fallback */
  }

  let plainTitle = stripMarkdown(stripReasoningBlocks(cleaned))
    .replace(/^["']|["']$/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n+/g, ' ')
    .trim()
  if (plainTitle.length > 40) plainTitle = plainTitle.slice(0, 40) + '...'
  return plainTitle ? { title: plainTitle, icon: 'message-square' } : null
}

/**
 * Use the active chat model to generate a short session title.
 * Runs in the background — does not block the main chat flow.
 * Returns { title, icon } or null on failure.
 */
export async function generateSessionTitle(
  userMessage: string,
  options?: {
    maxInputChars?: number
    timeoutMs?: number
    providerConfig?: ProviderConfig | null
  }
): Promise<SessionTitleResult | null> {
  const activeConfig =
    options?.providerConfig ?? useProviderStore.getState().getActiveProviderConfig()
  if (!isUsableProviderConfig(activeConfig)) return null

  const config = withTitleRequestDefaults(activeConfig)
  const maxInputChars = options?.maxInputChars ?? 1000

  if (config.type === 'openai-chat') {
    return requestOpenAIChatTitle(config, userMessage, maxInputChars)
  }

  const messages: UnifiedMessage[] = [
    {
      id: 'title-req',
      role: 'user',
      content: buildTitlePrompt(userMessage, maxInputChars),
      createdAt: Date.now()
    }
  ]

  const abortController = new AbortController()
  const timeout = window.setTimeout(() => abortController.abort(), options?.timeoutMs ?? 8000)

  try {
    const provider = createProvider(config)
    let title = ''
    for await (const event of provider.sendMessage(messages, [], config, abortController.signal)) {
      if (event.type === 'text_delta' && event.text) {
        title += event.text
      }
      if (event.type === 'message_end') {
        break
      }
      if (event.type === 'error') {
        console.warn('[AutoTitle] title request failed', event.error)
        return null
      }
    }
    return parseSessionTitleResponse(title)
  } catch (error) {
    console.warn('[AutoTitle] title request failed', error)
    return null
  } finally {
    window.clearTimeout(timeout)
  }
}
