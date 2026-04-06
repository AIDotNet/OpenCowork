import type {
  APIProvider,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage,
  ContentBlock
} from './types'
import { ipcStreamRequest, maskHeaders } from '../ipc/api-stream'
import { useProviderStore } from '@renderer/stores/provider-store'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { getGlobalPromptCacheKey, registerProvider } from './provider'

function resolveHeaderTemplate(value: string, config: ProviderConfig): string {
  return value
    .replace(/\{\{\s*sessionId\s*\}\}/g, config.sessionId ?? '')
    .replace(/\{\{\s*model\s*\}\}/g, config.model ?? '')
}

function applyHeaderOverrides(
  headers: Record<string, string>,
  config: ProviderConfig
): Record<string, string> {
  const overrides = config.requestOverrides?.headers
  if (!overrides) return headers
  for (const [key, rawValue] of Object.entries(overrides)) {
    const value = resolveHeaderTemplate(String(rawValue), config).trim()
    if (value) headers[key] = value
  }
  return headers
}

function applyBodyOverrides(body: Record<string, unknown>, config: ProviderConfig): void {
  const overrides = config.requestOverrides
  if (overrides?.body) {
    for (const [key, value] of Object.entries(overrides.body)) {
      body[key] = value
    }
  }
  if (overrides?.omitBodyKeys) {
    for (const key of overrides.omitBodyKeys) {
      delete body[key]
    }
  }
}

function isGoogleOpenAICompatible(config: ProviderConfig): boolean {
  if (config.providerBuiltinId === 'google') return true
  const baseUrl = (config.baseUrl || '').trim()
  return /generativelanguage\.googleapis\.com/i.test(baseUrl)
}

function getGoogleThoughtSignature(
  toolCall: { extra_content?: { google?: { thought_signature?: string } } } | null | undefined
): string | undefined {
  const signature = toolCall?.extra_content?.google?.thought_signature
  return typeof signature === 'string' && signature.trim() ? signature : undefined
}

const OPENAI_COMPAT_TERMINAL_GRACE_MS = 1500

class OpenAIChatProvider implements APIProvider {
  readonly name = 'OpenAI Chat Completions'
  readonly type = 'openai-chat' as const

  async *sendMessage(
    messages: UnifiedMessage[],
    tools: ToolDefinition[],
    config: ProviderConfig,
    signal?: AbortSignal
  ): AsyncIterable<StreamEvent> {
    let runtimeConfig = config
    if (config.providerId) {
      const ready = await ensureProviderAuthReady(config.providerId)
      if (!ready) {
        yield {
          type: 'error',
          error: { type: 'auth_error', message: 'Provider authentication is not ready' }
        }
        return
      }
      const latest = useProviderStore
        .getState()
        .providers.find((item) => item.id === config.providerId)
      if (latest) {
        runtimeConfig = {
          ...config,
          apiKey: latest.apiKey || config.apiKey,
          baseUrl: latest.baseUrl || config.baseUrl,
          userAgent: latest.userAgent ?? config.userAgent
        }
      }
    }

    const requestStartedAt = Date.now()
    let firstTokenAt: number | null = null
    let outputTokens = 0
    const baseUrl = (runtimeConfig.baseUrl || 'https://api.openai.com/v1')
      .trim()
      .replace(/\/+$/, '')
    const isOpenAI = /^https?:\/\/api\.openai\.com/i.test(baseUrl)
    const isGoogleCompatible = isGoogleOpenAICompatible(runtimeConfig)

    const body: Record<string, unknown> = {
      model: runtimeConfig.model,
      messages: this.formatMessages(messages, runtimeConfig.systemPrompt, runtimeConfig),
      stream: true,
      stream_options: { include_usage: true }
    }

    if (runtimeConfig.enablePromptCache !== false) {
      body.prompt_cache_key = getGlobalPromptCacheKey()
    }

    if (tools.length > 0) {
      body.tools = this.formatTools(tools)
      body.tool_choice = 'auto'
    }
    if (runtimeConfig.temperature !== undefined) body.temperature = runtimeConfig.temperature
    if (runtimeConfig.serviceTier) body.service_tier = runtimeConfig.serviceTier
    if (runtimeConfig.maxTokens) {
      // OpenAI o-series reasoning models use max_completion_tokens instead of max_tokens
      const isReasoningModel = /^(o[1-9]|o\d+-mini)/.test(runtimeConfig.model)
      if (isReasoningModel) {
        body.max_completion_tokens = runtimeConfig.maxTokens
      } else {
        body.max_tokens = runtimeConfig.maxTokens
      }
    }

    // Merge thinking/reasoning params when enabled; explicit disable params when off
    if (runtimeConfig.thinkingEnabled && runtimeConfig.thinkingConfig) {
      Object.assign(body, runtimeConfig.thinkingConfig.bodyParams)
      if (runtimeConfig.thinkingConfig.reasoningEffortLevels && runtimeConfig.reasoningEffort) {
        body.reasoning_effort = runtimeConfig.reasoningEffort
      }
      if (runtimeConfig.thinkingConfig.forceTemperature !== undefined) {
        body.temperature = runtimeConfig.thinkingConfig.forceTemperature
      }
    } else if (!runtimeConfig.thinkingEnabled && runtimeConfig.thinkingConfig?.disabledBodyParams) {
      Object.assign(body, runtimeConfig.thinkingConfig.disabledBodyParams)
    }

    applyBodyOverrides(body, runtimeConfig)

    const url = `${baseUrl}/chat/completions`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${runtimeConfig.apiKey}`
    }
    if (runtimeConfig.userAgent) headers['User-Agent'] = runtimeConfig.userAgent
    if (runtimeConfig.serviceTier) headers.service_tier = runtimeConfig.serviceTier
    applyHeaderOverrides(headers, runtimeConfig)

    const bodyStr = JSON.stringify(body)

    yield {
      type: 'request_debug',
      debugInfo: {
        url,
        method: 'POST',
        headers: maskHeaders(headers),
        body: bodyStr,
        timestamp: Date.now()
      }
    }

    const toolBuffers = new Map<
      number,
      {
        id: string
        name: string
        args: string
        extraContent?: { google?: { thought_signature?: string } }
      }
    >()
    let lastGoogleThoughtSignature: string | undefined
    const streamAbortController = new AbortController()
    let compatTerminalTimer: ReturnType<typeof setTimeout> | null = null
    const clearCompatTerminalTimer = (): void => {
      if (compatTerminalTimer) {
        clearTimeout(compatTerminalTimer)
        compatTerminalTimer = null
      }
    }
    const scheduleCompatTerminalClose = (): void => {
      if (isOpenAI || compatTerminalTimer) return
      compatTerminalTimer = setTimeout(() => {
        streamAbortController.abort()
      }, OPENAI_COMPAT_TERMINAL_GRACE_MS)
    }
    const abortRelay = (): void => {
      clearCompatTerminalTimer()
      streamAbortController.abort()
    }
    signal?.addEventListener('abort', abortRelay, { once: true })

    try {
      streamLoop: for await (const sse of ipcStreamRequest({
        url,
        method: 'POST',
        headers,
        body: bodyStr,
        signal: streamAbortController.signal,
        useSystemProxy: runtimeConfig.useSystemProxy,
        providerId: runtimeConfig.providerId,
        providerBuiltinId: runtimeConfig.providerBuiltinId
      })) {
        clearCompatTerminalTimer()
        if (!sse.data || sse.data === '[DONE]') break
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let data: any
        try {
          data = JSON.parse(sse.data)
        } catch {
          continue
        }
        const choice = data.choices?.[0]

        if (!choice) {
          if (data.usage) {
            outputTokens = data.usage.completion_tokens ?? outputTokens
            const requestCompletedAt = Date.now()
            yield {
              type: 'message_end',
              usage: {
                inputTokens: data.usage.prompt_tokens ?? 0,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...(data.usage.completion_tokens_details?.reasoning_tokens
                  ? { reasoningTokens: data.usage.completion_tokens_details.reasoning_tokens }
                  : {})
              },
              timing: {
                totalMs: requestCompletedAt - requestStartedAt,
                ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
                tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt)
              }
            }
          }
          continue
        }

        const delta = choice.delta

        if (delta?.reasoning_content) {
          if (firstTokenAt === null) firstTokenAt = Date.now()
          yield { type: 'thinking_delta', thinking: delta.reasoning_content }
        }

        if (delta?.reasoning_encrypted_content && isGoogleCompatible) {
          yield {
            type: 'thinking_encrypted',
            thinkingEncryptedContent: delta.reasoning_encrypted_content,
            thinkingEncryptedProvider: 'google'
          }
        }

        if (delta?.content) {
          if (firstTokenAt === null) firstTokenAt = Date.now()
          yield { type: 'text_delta', text: delta.content }
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            const googleThoughtSignature = isGoogleCompatible
              ? getGoogleThoughtSignature(tc)
              : undefined
            const googleExtraContent = googleThoughtSignature
              ? { google: { thought_signature: googleThoughtSignature } }
              : undefined

            if (googleThoughtSignature && googleThoughtSignature !== lastGoogleThoughtSignature) {
              lastGoogleThoughtSignature = googleThoughtSignature
              yield {
                type: 'thinking_encrypted',
                thinkingEncryptedContent: googleThoughtSignature,
                thinkingEncryptedProvider: 'google'
              }
            }

            let buf = toolBuffers.get(idx)

            if (!buf) {
              buf = {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                args: '',
                extraContent: googleExtraContent
              }
              toolBuffers.set(idx, buf)
              if (tc.id) {
                yield {
                  type: 'tool_call_start',
                  toolCallId: tc.id,
                  toolName: tc.function?.name,
                  ...(buf.extraContent ? { toolCallExtraContent: buf.extraContent } : {})
                }
              }
            } else {
              if (googleExtraContent && !buf.extraContent) {
                buf.extraContent = googleExtraContent
              }
              if (tc.id && !buf.id) {
                buf.id = tc.id
                yield {
                  type: 'tool_call_start',
                  toolCallId: tc.id,
                  toolName: buf.name || tc.function?.name,
                  ...(buf.extraContent ? { toolCallExtraContent: buf.extraContent } : {})
                }
              }
              if (tc.function?.name && !buf.name) buf.name = tc.function.name
            }

            if (tc.function?.arguments) {
              buf.args += tc.function.arguments
              yield {
                type: 'tool_call_delta',
                toolCallId: buf.id || undefined,
                argumentsDelta: tc.function.arguments
              }
            }
          }
        }

        const finishReason = choice.finish_reason as string | null | undefined

        if (finishReason === 'tool_calls' || finishReason === 'function_call') {
          for (const [, buf] of toolBuffers) {
            if (!buf.id) continue
            try {
              yield {
                type: 'tool_call_end',
                toolCallId: buf.id,
                toolName: buf.name,
                toolCallInput: JSON.parse(buf.args),
                ...(buf.extraContent ? { toolCallExtraContent: buf.extraContent } : {})
              }
            } catch {
              yield {
                type: 'tool_call_end',
                toolCallId: buf.id,
                toolName: buf.name,
                toolCallInput: {},
                ...(buf.extraContent ? { toolCallExtraContent: buf.extraContent } : {})
              }
            }
          }
          toolBuffers.clear()
          // Some OpenAI-compatible providers never close SSE after a terminal chunk.
          // Give them a short grace window to send a follow-up usage chunk, then end locally.
          if (!isOpenAI) {
            if (data.usage) break streamLoop
            scheduleCompatTerminalClose()
          }
        }

        // Compatibility fallback:
        // Some providers incorrectly return stop/length while still buffering tool args.
        if (
          finishReason &&
          finishReason !== 'tool_calls' &&
          finishReason !== 'function_call' &&
          toolBuffers.size > 0
        ) {
          for (const [, buf] of toolBuffers) {
            if (!buf.id) continue
            try {
              yield {
                type: 'tool_call_end',
                toolCallId: buf.id,
                toolName: buf.name,
                toolCallInput: JSON.parse(buf.args)
              }
            } catch {
              yield {
                type: 'tool_call_end',
                toolCallId: buf.id,
                toolName: buf.name,
                toolCallInput: {}
              }
            }
          }
          toolBuffers.clear()
          if (!isOpenAI) {
            if (data.usage) break streamLoop
            scheduleCompatTerminalClose()
          }
        }

        if (finishReason === 'stop') {
          const requestCompletedAt = Date.now()
          if (data.usage) {
            outputTokens = data.usage.completion_tokens ?? outputTokens
          }
          // Some providers include usage in the same chunk as finish_reason:'stop'
          yield {
            type: 'message_end',
            stopReason: 'stop',
            ...(data.usage
              ? {
                  usage: {
                    inputTokens: data.usage.prompt_tokens ?? 0,
                    outputTokens: data.usage.completion_tokens ?? 0,
                    ...(data.usage.completion_tokens_details?.reasoning_tokens
                      ? { reasoningTokens: data.usage.completion_tokens_details.reasoning_tokens }
                      : {})
                  }
                }
              : {}),
            timing: {
              totalMs: requestCompletedAt - requestStartedAt,
              ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
              tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt)
            }
          }
          // OpenAI-compatible providers may keep connection open after stop.
          // Keep a brief window for a trailing usage chunk, then close locally.
          if (!isOpenAI) {
            if (data.usage) break streamLoop
            scheduleCompatTerminalClose()
          }
        }

        if (finishReason === 'length' || finishReason === 'content_filter') {
          if (!isOpenAI) {
            if (data.usage) break streamLoop
            scheduleCompatTerminalClose()
          }
        }
      }

      // Flush remaining tool buffers for providers that don't send finish_reason:'tool_calls'
      if (toolBuffers.size > 0) {
        for (const [, buf] of toolBuffers) {
          if (!buf.id) continue
          try {
            yield {
              type: 'tool_call_end',
              toolCallId: buf.id,
              toolName: buf.name,
              toolCallInput: JSON.parse(buf.args),
              ...(buf.extraContent ? { toolCallExtraContent: buf.extraContent } : {})
            }
          } catch {
            yield {
              type: 'tool_call_end',
              toolCallId: buf.id,
              toolName: buf.name,
              toolCallInput: {},
              ...(buf.extraContent ? { toolCallExtraContent: buf.extraContent } : {})
            }
          }
        }
        toolBuffers.clear()
      }
    } finally {
      clearCompatTerminalTimer()
      signal?.removeEventListener('abort', abortRelay)
    }
  }

  formatMessages(
    messages: UnifiedMessage[],
    systemPrompt?: string,
    config?: ProviderConfig
  ): unknown[] {
    const formatted: unknown[] = []
    const isGoogleCompatible = config ? isGoogleOpenAICompatible(config) : false
    const normalizedMessages = this.normalizeMessagesForOpenAI(messages)

    if (systemPrompt) {
      formatted.push({ role: 'system', content: systemPrompt })
    }

    for (const m of normalizedMessages) {
      if (m.role === 'system') continue

      if (typeof m.content === 'string') {
        formatted.push({ role: m.role, content: m.content })
        continue
      }

      const blocks = m.content as ContentBlock[]

      // Handle user messages with images or text-only ContentBlock[]
      if (m.role === 'user') {
        const hasImages = blocks.some((b) => b.type === 'image')
        if (hasImages) {
          const parts: unknown[] = []
          for (const b of blocks) {
            if (b.type === 'image') {
              const url =
                b.source.type === 'base64'
                  ? `data:${b.source.mediaType || 'image/png'};base64,${b.source.data}`
                  : b.source.url || ''
              parts.push({ type: 'image_url', image_url: { url } })
            } else if (b.type === 'text') {
              parts.push({ type: 'text', text: b.text })
            }
          }
          formatted.push({ role: 'user', content: parts })
          continue
        }
        // Text-only ContentBlock[] (e.g., system-remind dynamic context injection)
        const userTextBlocks = blocks.filter((b) => b.type === 'text')
        if (userTextBlocks.length > 0) {
          const parts = userTextBlocks.map((b) => ({
            type: 'text',
            text: (b as Extract<ContentBlock, { type: 'text' }>).text
          }))
          formatted.push({ role: 'user', content: parts })
          continue
        }
      }

      // Handle tool results → role: "tool"
      const toolResults = blocks.filter((b) => b.type === 'tool_result')
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          if (tr.type === 'tool_result') {
            if (Array.isArray(tr.content)) {
              const parts: unknown[] = []
              for (const cb of tr.content) {
                if (cb.type === 'text') {
                  parts.push({ type: 'text', text: cb.text })
                } else if (cb.type === 'image') {
                  const dataUrl = `data:${cb.source.mediaType || 'image/png'};base64,${cb.source.data}`
                  parts.push({ type: 'image_url', image_url: { url: dataUrl } })
                }
              }
              formatted.push({ role: 'tool', tool_call_id: tr.toolUseId, content: parts })
            } else {
              formatted.push({ role: 'tool', tool_call_id: tr.toolUseId, content: tr.content })
            }
          }
        }
        continue
      }

      // Handle assistant with tool_use blocks
      const toolUses = blocks.filter((b) => b.type === 'tool_use')
      const textBlocks = blocks.filter((b) => b.type === 'text')
      const thinkingBlocks = blocks.filter((b) => b.type === 'thinking')
      const textContent = textBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
      const reasoningContent = thinkingBlocks
        .map((b) => (b.type === 'thinking' ? b.thinking : ''))
        .join('')
      const googleThinkingSignature = isGoogleCompatible
        ? [...thinkingBlocks]
            .reverse()
            .find(
              (b) =>
                b.type === 'thinking' &&
                b.encryptedContent &&
                (b.encryptedContentProvider === 'google' || !b.encryptedContentProvider)
            )?.encryptedContent
        : undefined

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg: any = { role: 'assistant', content: textContent || null }
      if (reasoningContent) msg.reasoning_content = reasoningContent
      if (googleThinkingSignature) {
        msg.reasoning_encrypted_content = googleThinkingSignature
      }

      if (toolUses.length > 0) {
        msg.tool_calls = toolUses
          .map((tu) => {
            if (tu.type !== 'tool_use') return null
            const extraContent = isGoogleCompatible
              ? (tu.extraContent ??
                (googleThinkingSignature
                  ? { google: { thought_signature: googleThinkingSignature } }
                  : undefined))
              : undefined
            return {
              id: tu.id,
              type: 'function',
              function: { name: tu.name, arguments: JSON.stringify(tu.input) },
              ...(extraContent ? { extra_content: extraContent } : {})
            }
          })
          .filter(Boolean)
      }
      formatted.push(msg)
    }

    return formatted
  }

  private normalizeMessagesForOpenAI(messages: UnifiedMessage[]): UnifiedMessage[] {
    const normalized: UnifiedMessage[] = []
    const validToolUseIds = new Set<string>()

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (message.role === 'system' || typeof message.content === 'string') {
        normalized.push(message)
        continue
      }

      const blocks = message.content as ContentBlock[]
      const replayableToolUseIds = new Set(
        blocks
          .filter(
            (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
          )
          .map((block) => block.id)
      )

      const pairedToolUseIds = new Set<string>()
      if (replayableToolUseIds.size > 0) {
        const nextMessage = messages[index + 1]
        if (nextMessage?.role === 'user' && Array.isArray(nextMessage.content)) {
          for (const block of nextMessage.content as ContentBlock[]) {
            if (block.type !== 'tool_result' || !replayableToolUseIds.has(block.toolUseId)) continue
            pairedToolUseIds.add(block.toolUseId)
            validToolUseIds.add(block.toolUseId)
          }
        }
      }

      const sanitizedBlocks = blocks.filter((block) => {
        if (block.type === 'tool_use') {
          return pairedToolUseIds.has(block.id)
        }
        if (block.type !== 'tool_result') return true
        return validToolUseIds.has(block.toolUseId)
      })

      if (sanitizedBlocks.length === 0) continue
      normalized.push({ ...message, content: sanitizedBlocks })
    }

    return normalized
  }

  formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: this.normalizeToolSchema(t.inputSchema)
      }
    }))
  }

  /**
   * OpenAI Chat Completions expects a root object schema with `properties`.
   * Our Task tool uses `oneOf` at the root, so collapse it into a single
   * object schema for compatibility.
   */
  private normalizeToolSchema(schema: ToolDefinition['inputSchema']): Record<string, unknown> {
    if ('properties' in schema) return schema

    const mergedProperties: Record<string, unknown> = {}
    let requiredIntersection: string[] | null = null

    for (const variant of schema.oneOf) {
      for (const [key, value] of Object.entries(variant.properties ?? {})) {
        if (!(key in mergedProperties)) mergedProperties[key] = value
      }

      const required = variant.required ?? []
      if (requiredIntersection === null) {
        requiredIntersection = [...required]
      } else {
        requiredIntersection = requiredIntersection.filter((key) => required.includes(key))
      }
    }

    const normalized: Record<string, unknown> = {
      type: 'object',
      properties: mergedProperties,
      additionalProperties: false
    }

    if (requiredIntersection && requiredIntersection.length > 0) {
      normalized.required = requiredIntersection
    }

    return normalized
  }
}

function computeTps(
  outputTokens: number,
  firstTokenAt: number | null,
  completedAt: number
): number | undefined {
  if (!firstTokenAt || outputTokens <= 0) return undefined
  const durationMs = completedAt - firstTokenAt
  if (durationMs <= 0) return undefined
  return outputTokens / (durationMs / 1000)
}

export function registerOpenAIChatProvider(): void {
  registerProvider('openai-chat', () => new OpenAIChatProvider())
}
