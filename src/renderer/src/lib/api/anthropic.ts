import type {
  APIProvider,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage,
  ContentBlock,
  TokenUsage
} from './types'
import { ipcStreamRequest, maskHeaders } from '../ipc/api-stream'
import { registerProvider } from './provider'
import { sanitizeMessagesForToolReplay } from '../tools/tool-input-sanitizer'

function buildAnthropicCacheControl(): { type: 'ephemeral' } {
  return { type: 'ephemeral' }
}

function resolveAnthropicEffort(
  config: ProviderConfig
): 'low' | 'medium' | 'high' | 'max' | undefined {
  const levels = config.thinkingConfig?.reasoningEffortLevels
  if (!levels || levels.length === 0) return undefined

  const selected =
    config.reasoningEffort && levels.includes(config.reasoningEffort)
      ? config.reasoningEffort
      : (config.thinkingConfig?.defaultReasoningEffort ?? levels[0])

  switch (selected) {
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
      return selected
    case 'xhigh':
      return 'max'
    default:
      return undefined
  }
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function readAnthropicThinkingBudget(config: ProviderConfig): number | undefined {
  if (!config.thinkingEnabled) return undefined

  const thinking = config.thinkingConfig?.bodyParams?.thinking
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) return undefined

  const budgetValue = (thinking as Record<string, unknown>).budget_tokens
  const budgetTokens =
    typeof budgetValue === 'number'
      ? budgetValue
      : typeof budgetValue === 'string'
        ? Number(budgetValue)
        : undefined

  return Number.isFinite(budgetTokens) && budgetTokens != null && budgetTokens > 0
    ? Math.floor(budgetTokens)
    : undefined
}

function resolveAnthropicMaxTokens(config: ProviderConfig): number {
  const configuredMaxTokens = Math.max(1, Math.floor(config.maxTokens ?? 32000))
  const thinkingBudget = readAnthropicThinkingBudget(config)
  return thinkingBudget != null ? Math.max(configuredMaxTokens, thinkingBudget + 1) : configuredMaxTokens
}

function buildAnthropicThinkingBodyParams(config: ProviderConfig): Record<string, unknown> | undefined {
  const bodyParams = config.thinkingConfig?.bodyParams
  if (!config.thinkingEnabled || !bodyParams) return undefined

  const nextBodyParams: Record<string, unknown> = { ...bodyParams }
  const thinking = bodyParams.thinking

  if (thinking && typeof thinking === 'object' && !Array.isArray(thinking)) {
    nextBodyParams.thinking = { ...(thinking as Record<string, unknown>) }
  }

  return nextBodyParams
}

function extractAnthropicCacheCreationUsage(usage: Record<string, unknown> | undefined): Partial<TokenUsage> {
  if (!usage) return {}

  const cacheCreation =
    usage.cache_creation && typeof usage.cache_creation === 'object'
      ? (usage.cache_creation as Record<string, unknown>)
      : undefined

  const cacheCreation5mTokens = readNonNegativeNumber(cacheCreation?.ephemeral_5m_input_tokens)
  const cacheCreation1hTokens = readNonNegativeNumber(cacheCreation?.ephemeral_1h_input_tokens)

  if (cacheCreation5mTokens != null || cacheCreation1hTokens != null) {
    const total = (cacheCreation5mTokens ?? 0) + (cacheCreation1hTokens ?? 0)
    return {
      ...(total > 0 ? { cacheCreationTokens: total } : {}),
      ...(cacheCreation5mTokens != null ? { cacheCreation5mTokens } : {}),
      ...(cacheCreation1hTokens != null ? { cacheCreation1hTokens } : {})
    }
  }

  const cacheCreationTokens = readNonNegativeNumber(usage.cache_creation_input_tokens)
  return cacheCreationTokens != null
    ? {
        cacheCreationTokens,
        cacheCreation5mTokens: cacheCreationTokens
      }
    : {}
}

class AnthropicProvider implements APIProvider {
  readonly name = 'Anthropic Messages'
  readonly type = 'anthropic' as const

  async *sendMessage(
    messages: UnifiedMessage[],
    tools: ToolDefinition[],
    config: ProviderConfig,
    signal?: AbortSignal
  ): AsyncIterable<StreamEvent> {
    const requestStartedAt = Date.now()
    let firstTokenAt: number | null = null
    let outputTokens = 0
    const promptCacheEnabled = config.enablePromptCache !== false
    const systemPromptCacheEnabled = config.enableSystemPromptCache !== false
    const thinkingBodyParams = buildAnthropicThinkingBodyParams(config)
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: resolveAnthropicMaxTokens(config),
      ...(promptCacheEnabled ? { cache_control: buildAnthropicCacheControl() } : {}),
      ...(config.systemPrompt
        ? {
            system: [
              {
                type: 'text',
                text: config.systemPrompt,
                ...(systemPromptCacheEnabled ? { cache_control: buildAnthropicCacheControl() } : {})
              }
            ]
          }
        : {}),
      messages: this.formatMessages(
        this.normalizeMessagesForAnthropic(sanitizeMessagesForToolReplay(messages)),
        promptCacheEnabled
      ),
      ...(tools.length > 0
        ? { tools: this.formatTools(tools, promptCacheEnabled), tool_choice: { type: 'auto' } }
        : {}),
      stream: true
    }

    if (config.thinkingEnabled && config.thinkingConfig) {
      if (thinkingBodyParams) Object.assign(body, thinkingBodyParams)
      const effort = resolveAnthropicEffort(config)
      if (effort) {
        body.output_config = {
          ...(typeof body.output_config === 'object' && body.output_config !== null
            ? (body.output_config as Record<string, unknown>)
            : {}),
          effort
        }
      }
      if (config.thinkingConfig.forceTemperature !== undefined) {
        body.temperature = config.thinkingConfig.forceTemperature
      }
    } else if (!config.thinkingEnabled && config.thinkingConfig?.disabledBodyParams) {
      Object.assign(body, config.thinkingConfig.disabledBodyParams)
    }

    body.max_tokens = resolveAnthropicMaxTokens(config)

    const baseUrl = (config.baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '')
    const url = `${baseUrl}/v1/messages`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31,interleaved-thinking-2025-05-14'
    }
    if (config.userAgent) headers['User-Agent'] = config.userAgent
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

    const toolBuffersByBlockIndex = new Map<number, string>()
    const toolCallsByBlockIndex = new Map<number, { id: string; name: string }>()
    const emittedThinkingEncrypted = new Set<string>()

    const tryBuildThinkingEncryptedEvent = (encryptedContent: unknown): StreamEvent | null => {
      if (typeof encryptedContent !== 'string') return null
      const trimmed = encryptedContent.trim()
      if (!trimmed || emittedThinkingEncrypted.has(trimmed)) return null
      emittedThinkingEncrypted.add(trimmed)
      return {
        type: 'thinking_encrypted',
        thinkingEncryptedContent: trimmed,
        thinkingEncryptedProvider: 'anthropic'
      }
    }

    const pendingUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

    for await (const sse of ipcStreamRequest({
      url,
      method: 'POST',
      headers,
      body: bodyStr,
      signal,
      allowInsecureTls: config.allowInsecureTls ?? true,
      providerId: config.providerId,
      providerBuiltinId: config.providerBuiltinId,
      accountId: config.accountId
    })) {
      if (!sse.data || sse.data === '[DONE]') continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any
      try {
        data = JSON.parse(sse.data)
      } catch {
        continue
      }

      switch (data.type) {
        case 'message_start': {
          const msgUsage = data.message?.usage
          if (msgUsage) {
            pendingUsage.inputTokens = msgUsage.input_tokens ?? 0
            Object.assign(pendingUsage, extractAnthropicCacheCreationUsage(msgUsage))
            if (msgUsage.cache_read_input_tokens) {
              pendingUsage.cacheReadTokens = msgUsage.cache_read_input_tokens
            }
          }
          yield { type: 'message_start' }
          break
        }

        case 'content_block_start': {
          const blockIndex = Number.isFinite(data.index) ? Number(data.index) : -1
          if (data.content_block.type === 'tool_use' && blockIndex >= 0) {
            toolBuffersByBlockIndex.set(blockIndex, '')
            toolCallsByBlockIndex.set(blockIndex, {
              id: data.content_block.id,
              name: data.content_block.name
            })
            yield {
              type: 'tool_call_start',
              toolCallId: data.content_block.id,
              toolName: data.content_block.name
            }
          } else if (data.content_block.type === 'thinking') {
            const thinkingEncryptedEvent = tryBuildThinkingEncryptedEvent(
              data.content_block.signature ?? data.content_block.encrypted_content
            )
            if (thinkingEncryptedEvent) {
              yield thinkingEncryptedEvent
            }
          }
          break
        }

        case 'content_block_delta': {
          const blockIndex = Number.isFinite(data.index) ? Number(data.index) : -1
          if (firstTokenAt === null) firstTokenAt = Date.now()
          if (data.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: data.delta.text }
          } else if (data.delta.type === 'thinking_delta') {
            yield { type: 'thinking_delta', thinking: data.delta.thinking }
          } else if (data.delta.type === 'signature_delta') {
            const thinkingEncryptedEvent = tryBuildThinkingEncryptedEvent(
              data.delta.signature ?? data.delta.encrypted_content
            )
            if (thinkingEncryptedEvent) {
              yield thinkingEncryptedEvent
            }
          } else if (data.delta.type === 'input_json_delta' && blockIndex >= 0) {
            const next = `${toolBuffersByBlockIndex.get(blockIndex) ?? ''}${data.delta.partial_json}`
            toolBuffersByBlockIndex.set(blockIndex, next)
            const toolCall = toolCallsByBlockIndex.get(blockIndex)
            yield {
              type: 'tool_call_delta',
              toolCallId: toolCall?.id,
              argumentsDelta: data.delta.partial_json
            }
          }
          break
        }

        case 'content_block_stop': {
          const blockIndex = Number.isFinite(data.index) ? Number(data.index) : -1
          const toolCall = blockIndex >= 0 ? toolCallsByBlockIndex.get(blockIndex) : undefined
          if (toolCall) {
            const raw = (toolBuffersByBlockIndex.get(blockIndex) ?? '').trim()
            if (raw) {
              try {
                yield {
                  type: 'tool_call_end',
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  toolCallInput: JSON.parse(raw)
                }
              } catch {
                yield {
                  type: 'tool_call_end',
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  toolCallInput: {}
                }
              }
            } else {
              yield {
                type: 'tool_call_end',
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                toolCallInput: {}
              }
            }
            toolBuffersByBlockIndex.delete(blockIndex)
            toolCallsByBlockIndex.delete(blockIndex)
          }
          break
        }

        case 'message_delta': {
          if (toolCallsByBlockIndex.size > 0) {
            for (const [blockIndex, toolCall] of toolCallsByBlockIndex) {
              const raw = (toolBuffersByBlockIndex.get(blockIndex) ?? '').trim()
              let parsed: Record<string, unknown> = {}
              if (raw) {
                try {
                  parsed = JSON.parse(raw) as Record<string, unknown>
                } catch {
                  parsed = {}
                }
              }
              yield {
                type: 'tool_call_end',
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                toolCallInput: parsed
              }
            }
            toolCallsByBlockIndex.clear()
            toolBuffersByBlockIndex.clear()
          }

          const requestCompletedAt = Date.now()
          pendingUsage.outputTokens = data.usage?.output_tokens ?? 0
          outputTokens = pendingUsage.outputTokens
          yield {
            type: 'message_end',
            stopReason: data.delta.stop_reason,
            usage: { ...pendingUsage },
            timing: {
              totalMs: requestCompletedAt - requestStartedAt,
              ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
              tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt)
            }
          }
          break
        }

        case 'error':
          yield { type: 'error', error: data.error }
          break
      }
    }
  }

  formatMessages(messages: UnifiedMessage[], promptCacheEnabled = false): unknown[] {
    return messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (typeof m.content === 'string') {
          if (!promptCacheEnabled || !m.content.trim()) {
            return { role: m.role, content: m.content }
          }

          return {
            role: m.role,
            content: [
              {
                type: 'text',
                text: m.content,
                cache_control: buildAnthropicCacheControl()
              }
            ]
          }
        }

        const blocks = m.content as ContentBlock[]
        return {
          role: m.role === 'tool' ? 'user' : m.role,
          content: blocks.map((b) => {
            switch (b.type) {
              case 'thinking':
                return {
                  type: 'thinking',
                  thinking: b.thinking,
                  ...(b.encryptedContent &&
                  (b.encryptedContentProvider === 'anthropic' || !b.encryptedContentProvider)
                    ? { signature: b.encryptedContent }
                    : {})
                }
              case 'text':
                return {
                  type: 'text',
                  text: b.text,
                  ...(promptCacheEnabled && b.text.trim()
                    ? { cache_control: buildAnthropicCacheControl() }
                    : {})
                }
              case 'tool_use':
                return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
              case 'tool_result': {
                let formattedContent: unknown = b.content
                if (Array.isArray(b.content)) {
                  formattedContent = b.content.map((cb) => {
                    if (cb.type === 'image') {
                      return {
                        type: 'image',
                        source: {
                          type: cb.source.type,
                          media_type: cb.source.mediaType,
                          data: cb.source.data
                        }
                      }
                    }
                    return cb
                  })
                }
                return {
                  type: 'tool_result',
                  tool_use_id: b.toolUseId,
                  content: formattedContent,
                  ...(promptCacheEnabled ? { cache_control: buildAnthropicCacheControl() } : {})
                }
              }
              case 'image':
                return {
                  type: 'image',
                  source: {
                    type: b.source.type,
                    media_type: b.source.mediaType,
                    data: b.source.data,
                    ...(b.source.url ? { url: b.source.url } : {})
                  },
                  ...(promptCacheEnabled ? { cache_control: buildAnthropicCacheControl() } : {})
                }
              default:
                return { type: 'text', text: '[unsupported block]' }
            }
          })
        }
      })
  }

  private normalizeMessagesForAnthropic(messages: UnifiedMessage[]): UnifiedMessage[] {
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

  formatTools(tools: ToolDefinition[], promptCacheEnabled = false): unknown[] {
    return tools.map((t, index) => ({
      name: t.name,
      description: t.description,
      input_schema: this.normalizeToolSchema(t.inputSchema),
      ...(promptCacheEnabled && index === tools.length - 1
        ? { cache_control: buildAnthropicCacheControl() }
        : {})
    }))
  }

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

export function registerAnthropicProvider(): void {
  registerProvider('anthropic', () => new AnthropicProvider())
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
