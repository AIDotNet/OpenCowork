import type {
  APIProvider,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage,
  ContentBlock,
  TokenUsage,
} from './types'
import { ipcStreamRequest, maskHeaders } from '../ipc/api-stream'
import { registerProvider } from './provider'

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
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxTokens ?? 32000,
      ...(config.systemPrompt
        ? { system: [{ type: 'text', text: config.systemPrompt, ...(config.enableSystemPromptCache ? { cache_control: { type: 'ephemeral' } } : {}) }] }
        : {}),
      messages: this.formatMessages(messages),
      ...(tools.length > 0 ? { tools: this.formatTools(tools), tool_choice: { type: 'auto' } } : {}),
      stream: true,
    }

    // Merge thinking/reasoning params when enabled; explicit disable params when off
    if (config.thinkingEnabled && config.thinkingConfig) {
      Object.assign(body, config.thinkingConfig.bodyParams)
      if (config.thinkingConfig.forceTemperature !== undefined) {
        body.temperature = config.thinkingConfig.forceTemperature
      }
    } else if (!config.thinkingEnabled && config.thinkingConfig?.disabledBodyParams) {
      Object.assign(body, config.thinkingConfig.disabledBodyParams)
    }

    const baseUrl = (config.baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '')
    const url = `${baseUrl}/v1/messages`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31,interleaved-thinking-2025-05-14',
    }
    if (config.userAgent) headers['User-Agent'] = config.userAgent
    const bodyStr = JSON.stringify(body)

    // Yield debug info for dev mode inspection
    yield { type: 'request_debug', debugInfo: { url, method: 'POST', headers: maskHeaders(headers), body: bodyStr, timestamp: Date.now() } }

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
        thinkingEncryptedProvider: 'anthropic',
      }
    }

    // Anthropic splits usage across two events:
    // - message_start → input_tokens, cache_creation_input_tokens, cache_read_input_tokens
    // - message_delta → output_tokens
    // We accumulate the message_start usage and merge it into message_end.
    const pendingUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

    for await (const sse of ipcStreamRequest({
      url,
      method: 'POST',
      headers,
      body: bodyStr,
      signal,
      providerId: config.providerId,
      providerBuiltinId: config.providerBuiltinId,
    })) {
      if (!sse.data || sse.data === '[DONE]') continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any
      try {
        data = JSON.parse(sse.data)
      } catch {
        continue // Skip non-JSON SSE events (keep-alives, partial chunks)
      }

      switch (data.type) {
        case 'message_start': {
          const msgUsage = data.message?.usage
          if (msgUsage) {
            pendingUsage.inputTokens = msgUsage.input_tokens ?? 0
            if (msgUsage.cache_creation_input_tokens) {
              pendingUsage.cacheCreationTokens = msgUsage.cache_creation_input_tokens
            }
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
              name: data.content_block.name,
            })
            yield {
              type: 'tool_call_start',
              toolCallId: data.content_block.id,
              toolName: data.content_block.name,
            }
          } else if (data.content_block.type === 'thinking') {
            const thinkingEncryptedEvent = tryBuildThinkingEncryptedEvent(
              data.content_block.signature ?? data.content_block.encrypted_content
            )
            if (thinkingEncryptedEvent) {
              yield thinkingEncryptedEvent
            }
          }
          // thinking blocks are handled via their deltas
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
              argumentsDelta: data.delta.partial_json,
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
                  toolCallInput: JSON.parse(raw),
                }
              } catch {
                yield {
                  type: 'tool_call_end',
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  toolCallInput: {},
                }
              }
            } else {
              // Anthropic may omit input_json_delta for empty tool input "{}".
              yield {
                type: 'tool_call_end',
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                toolCallInput: {},
              }
            }
            toolBuffersByBlockIndex.delete(blockIndex)
            toolCallsByBlockIndex.delete(blockIndex)
          }
          break
        }

        case 'message_delta': {
          // Defensive flush: in rare provider edge-cases a tool block can remain unclosed.
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
                toolCallInput: parsed,
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
              tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt),
            },
          }
          break
        }

        case 'error':
          yield { type: 'error', error: data.error }
          break
      }
    }
  }

  formatMessages(messages: UnifiedMessage[]): unknown[] {
    return messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (typeof m.content === 'string') {
          return { role: m.role, content: m.content }
        }
        // Convert ContentBlock[] to Anthropic format
        const blocks = m.content as ContentBlock[]
        return {
          role: m.role === 'tool' ? 'user' : m.role,
          content: blocks.map((b) => {
            switch (b.type) {
              case 'thinking':
                return {
                  type: 'thinking',
                  thinking: b.thinking,
                  ...(b.encryptedContent && (b.encryptedContentProvider === 'anthropic' || !b.encryptedContentProvider)
                    ? { signature: b.encryptedContent }
                    : {}),
                }
              case 'text':
                return { type: 'text', text: b.text }
              case 'tool_use':
                return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
              case 'tool_result': {
                let formattedContent: unknown = b.content
                if (Array.isArray(b.content)) {
                  formattedContent = b.content.map((cb) => {
                    if (cb.type === 'image') {
                      return { type: 'image', source: { type: cb.source.type, media_type: cb.source.mediaType, data: cb.source.data } }
                    }
                    return cb
                  })
                }
                return { type: 'tool_result', tool_use_id: b.toolUseId, content: formattedContent }
              }
              case 'image':
                return { type: 'image', source: b.source }
              default:
                return { type: 'text', text: '[unsupported block]' }
            }
          }),
        }
      })
  }

  formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))
  }
}

export function registerAnthropicProvider(): void {
  registerProvider('anthropic', () => new AnthropicProvider())
}

function computeTps(outputTokens: number, firstTokenAt: number | null, completedAt: number): number | undefined {
  if (!firstTokenAt || outputTokens <= 0) return undefined
  const durationMs = completedAt - firstTokenAt
  if (durationMs <= 0) return undefined
  return outputTokens / (durationMs / 1000)
}
