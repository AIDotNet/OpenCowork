import type {
  APIProvider,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage,
  ContentBlock,
} from './types'
import { ipcStreamRequest, maskHeaders } from '../ipc/api-stream'
import { loadPrompt } from '../prompts/prompt-loader'
import { registerProvider } from './provider'

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

class OpenAIResponsesProvider implements APIProvider {
  readonly name = 'OpenAI Responses'
  readonly type = 'openai-responses' as const

  async *sendMessage(
    messages: UnifiedMessage[],
    tools: ToolDefinition[],
    config: ProviderConfig,
    signal?: AbortSignal
  ): AsyncIterable<StreamEvent> {
    const requestStartedAt = Date.now()
    let firstTokenAt: number | null = null
    let outputTokens = 0
    const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')

    const body: Record<string, unknown> = {
      model: config.model,
      input: this.formatMessages(messages, config.systemPrompt, !!config.thinkingEnabled),
      stream: true,
    }

    // Enable prompt caching for OpenAI endpoints to reduce costs
    if (config.sessionId) {
      body.prompt_cache_key = `opencowork-${config.sessionId}`
    }

    if (tools.length > 0) {
      body.tools = this.formatTools(tools)
    }
    if (config.temperature !== undefined) body.temperature = config.temperature
    if (config.maxTokens) body.max_output_tokens = config.maxTokens

    // Merge thinking/reasoning params when enabled; explicit disable params when off
    if (config.thinkingEnabled && config.thinkingConfig) {
      Object.assign(body, config.thinkingConfig.bodyParams)

      const reasoning =
        typeof body.reasoning === 'object' && body.reasoning !== null
          ? { ...(body.reasoning as Record<string, unknown>) }
          : {}

      if (config.thinkingConfig.reasoningEffortLevels && config.reasoningEffort) {
        reasoning.effort = config.reasoningEffort
      }
      reasoning.summary = config.responseSummary ?? 'auto'
      if (Object.keys(reasoning).length > 0) {
        body.reasoning = reasoning
      }

      const include = Array.isArray(body.include)
        ? (body.include as unknown[]).filter((item): item is string => typeof item === 'string')
        : []
      if (!include.includes('reasoning.encrypted_content')) {
        include.push('reasoning.encrypted_content')
      }
      body.include = include

      if (config.thinkingConfig.forceTemperature !== undefined) {
        body.temperature = config.thinkingConfig.forceTemperature
      }
    } else if (!config.thinkingEnabled && config.thinkingConfig?.disabledBodyParams) {
      Object.assign(body, config.thinkingConfig.disabledBodyParams)
    }

    const overridesBody = config.requestOverrides?.body
    const hasInstructionsOverride = !!overridesBody &&
      Object.prototype.hasOwnProperty.call(overridesBody, 'instructions')

    if (!hasInstructionsOverride && config.instructionsPrompt) {
      const instructions = await loadPrompt(config.instructionsPrompt)
      if (!instructions) {
        yield {
          type: 'error',
          error: {
            type: 'config_error',
            message: `Instructions prompt "${config.instructionsPrompt}" not found`,
          },
        }
        return
      }
      body.instructions = instructions
    }

    applyBodyOverrides(body, config)

    const url = `${baseUrl}/responses`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    }
    if (config.userAgent) headers['User-Agent'] = config.userAgent
    applyHeaderOverrides(headers, config)

    const bodyStr = JSON.stringify(body)

    // Yield debug info for dev mode inspection
    yield { type: 'request_debug', debugInfo: { url, method: 'POST', headers: maskHeaders(headers), body: bodyStr, timestamp: Date.now() } }

    const argBuffers = new Map<string, string>()
    const emittedThinkingEncrypted = new Set<string>()
    let emittedThinkingDelta = false

    const extractReasoningSummaryText = (summary: unknown): string => {
      if (typeof summary === 'string') return summary
      if (!Array.isArray(summary)) return ''
      return summary
        .map((part) => {
          if (typeof part === 'string') return part
          if (!part || typeof part !== 'object') return ''
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        })
        .join('')
    }

    const tryBuildThinkingDeltaEvent = (thinking: unknown): StreamEvent | null => {
      if (typeof thinking !== 'string' || !thinking) return null
      emittedThinkingDelta = true
      return { type: 'thinking_delta', thinking }
    }

    const tryBuildThinkingEncryptedEvent = (encryptedContent: unknown): StreamEvent | null => {
      if (typeof encryptedContent !== 'string') return null
      const trimmed = encryptedContent.trim()
      if (!trimmed || emittedThinkingEncrypted.has(trimmed)) return null
      emittedThinkingEncrypted.add(trimmed)
      return {
        type: 'thinking_encrypted',
        thinkingEncryptedContent: trimmed,
        thinkingEncryptedProvider: 'openai-responses',
      }
    }

    for await (const sse of ipcStreamRequest({
      url,
      method: 'POST',
      headers,
      body: bodyStr,
      signal,
      useSystemProxy: config.useSystemProxy,
      providerId: config.providerId,
      providerBuiltinId: config.providerBuiltinId,
    })) {
      if (!sse.data || sse.data === '[DONE]') continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any
      try {
        data = JSON.parse(sse.data)
      } catch {
        continue
      }

      switch (sse.event) {
        case 'response.output_text.delta':
          if (firstTokenAt === null) firstTokenAt = Date.now()
          yield { type: 'text_delta', text: data.delta }
          break

        case 'response.reasoning_summary_text.delta': {
          if (firstTokenAt === null) firstTokenAt = Date.now()
          const thinkingEvent = tryBuildThinkingDeltaEvent(data.delta)
          if (thinkingEvent) {
            yield thinkingEvent
          }
          break
        }

        case 'response.reasoning_summary_text.done': {
          if (firstTokenAt === null) firstTokenAt = Date.now()
          if (!emittedThinkingDelta) {
            const thinkingEvent = tryBuildThinkingDeltaEvent(
              data.text ?? data.delta ?? extractReasoningSummaryText(data.summary)
            )
            if (thinkingEvent) {
              yield thinkingEvent
            }
          }
          break
        }

        case 'response.output_item.added':
          if (data.item?.type === 'function_call') {
            argBuffers.set(data.item.id, '')
            yield {
              type: 'tool_call_start',
              toolCallId: data.item.call_id,
              toolName: data.item.name,
            }
          } else if (data.item?.type === 'reasoning') {
            const thinkingEncryptedEvent = tryBuildThinkingEncryptedEvent(
              data.item.encrypted_content ?? data.item.reasoning?.encrypted_content
            )
            if (thinkingEncryptedEvent) {
              yield thinkingEncryptedEvent
            }
          }
          break

        case 'response.output_item.done': {
          if (firstTokenAt === null) firstTokenAt = Date.now()
          if (!emittedThinkingDelta) {
            const thinkingEvent = tryBuildThinkingDeltaEvent(
              extractReasoningSummaryText(data.item?.summary ?? data.item?.reasoning?.summary)
            )
            if (thinkingEvent) {
              yield thinkingEvent
            }
          }

          const thinkingEncryptedEvent = tryBuildThinkingEncryptedEvent(
            data.item?.encrypted_content ?? data.item?.reasoning?.encrypted_content
          )
          if (thinkingEncryptedEvent) {
            yield thinkingEncryptedEvent
          }
          break
        }

        case 'response.function_call_arguments.delta': {
          yield { type: 'tool_call_delta', argumentsDelta: data.delta }
          const key = data.item_id
          argBuffers.set(key, (argBuffers.get(key) ?? '') + data.delta)
          break
        }

        case 'response.function_call_arguments.done':
          try {
            yield { type: 'tool_call_end', toolCallId: data.call_id, toolName: data.name, toolCallInput: JSON.parse(data.arguments) }
          } catch {
            yield { type: 'tool_call_end', toolCallId: data.call_id, toolName: data.name, toolCallInput: {} }
          }
          break

        case 'response.completed': {
          const requestCompletedAt = Date.now()
          const responseOutput = data.response?.output
          if (Array.isArray(responseOutput)) {
            for (const item of responseOutput) {
              if (!emittedThinkingDelta) {
                const thinkingEvent = tryBuildThinkingDeltaEvent(
                  extractReasoningSummaryText(item?.summary ?? item?.reasoning?.summary)
                )
                if (thinkingEvent) {
                  if (firstTokenAt === null) firstTokenAt = Date.now()
                  yield thinkingEvent
                }
              }

              const thinkingEncryptedEvent = tryBuildThinkingEncryptedEvent(
                item?.encrypted_content ?? item?.reasoning?.encrypted_content
              )
              if (thinkingEncryptedEvent) {
                yield thinkingEncryptedEvent
              }
            }
          }
          if (data.response?.usage?.output_tokens !== undefined) {
            outputTokens = data.response.usage.output_tokens ?? outputTokens
          }
          const cachedTokens = data.response?.usage?.input_tokens_details?.cached_tokens ?? 0
          const rawInputTokens = data.response?.usage?.input_tokens ?? 0
          yield {
            type: 'message_end',
            stopReason: data.response.status,
            usage: data.response.usage
              ? {
                inputTokens: rawInputTokens,
                outputTokens: data.response.usage.output_tokens ?? 0,
                contextTokens: rawInputTokens,
                ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
                ...(data.response.usage.output_tokens_details?.reasoning_tokens
                  ? { reasoningTokens: data.response.usage.output_tokens_details.reasoning_tokens }
                  : {}),
              }
              : undefined,
            timing: {
              totalMs: requestCompletedAt - requestStartedAt,
              ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
              tps: computeTps(outputTokens, firstTokenAt, requestCompletedAt),
            },
          }
          break
        }

        case 'response.failed':
        case 'error':
          yield { type: 'error', error: { type: 'api_error', message: JSON.stringify(data) } }
          break
      }
    }
  }

  formatMessages(
    messages: UnifiedMessage[],
    systemPrompt?: string,
    includeEncryptedReasoning = false
  ): unknown[] {
    const input: unknown[] = []

    if (systemPrompt) {
      input.push({ type: 'message', role: 'developer', content: systemPrompt })
    }

    for (const m of messages) {
      if (m.role === 'system') continue

      if (typeof m.content === 'string') {
        input.push({ type: 'message', role: m.role, content: m.content })
        continue
      }

      const blocks = m.content as ContentBlock[]

      // Handle user messages with images → multi-part content
      if (m.role === 'user') {
        const hasImages = blocks.some((b) => b.type === 'image')
        if (hasImages) {
          const parts: unknown[] = []
          for (const b of blocks) {
            if (b.type === 'image') {
              const url = b.source.type === 'base64'
                ? `data:${b.source.mediaType || 'image/png'};base64,${b.source.data}`
                : b.source.url || ''
              parts.push({ type: 'input_image', image_url: url })
            } else if (b.type === 'text') {
              parts.push({ type: 'input_text', text: b.text })
            }
          }
          input.push({ type: 'message', role: 'user', content: parts })
          continue
        }
      }

      for (const block of blocks) {
        switch (block.type) {
          case 'text':
            input.push({ type: 'message', role: m.role, content: block.text })
            break
          case 'thinking':
            if (
              includeEncryptedReasoning &&
              m.role === 'assistant' &&
              block.encryptedContent &&
              (block.encryptedContentProvider === 'openai-responses' || !block.encryptedContentProvider)
            ) {
              input.push({
                type: 'reasoning',
                summary: block.thinking
                  ? [{ type: 'summary_text', text: block.thinking }]
                  : [],
                encrypted_content: block.encryptedContent,
              })
            }
            break
          case 'tool_use':
            input.push({
              type: 'function_call',
              call_id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input),
              status: 'completed',
            })
            break
          case 'tool_result': {
            // OpenAI Responses API function_call_output only supports string output
            let output: string
            if (Array.isArray(block.content)) {
              const textParts = block.content.filter((cb) => cb.type === 'text').map((cb) => cb.type === 'text' ? cb.text : '')
              const imageParts = block.content.filter((cb) => cb.type === 'image')
              output = [
                ...textParts,
                ...imageParts.map(() => '[Image attached]'),
              ].join('\n') || '[Image]'
            } else {
              output = block.content
            }
            input.push({
              type: 'function_call_output',
              call_id: block.toolUseId,
              output,
            })
            break
          }
        }
      }
    }

    return input
  }

  formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: 'function',
      // Responses API uses internally tagged function tools (top-level name/parameters).
      name: t.name,
      description: t.description,
      parameters: this.normalizeToolSchema(t.inputSchema),
      // Keep non-strict behavior for existing tool schemas (Chat Completions parity).
      strict: false,
    }))
  }

  /**
   * OpenAI Responses requires a root object schema with `properties`.
   * Our Task tool currently uses `oneOf` at the root, so collapse it into
   * a single object schema for compatibility.
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
      additionalProperties: false,
    }

    if (requiredIntersection && requiredIntersection.length > 0) {
      normalized.required = requiredIntersection
    }

    return normalized
  }
}

function computeTps(outputTokens: number, firstTokenAt: number | null, completedAt: number): number | undefined {
  if (!firstTokenAt || outputTokens <= 0) return undefined
  const durationMs = completedAt - firstTokenAt
  if (durationMs <= 0) return undefined
  return outputTokens / (durationMs / 1000)
}

export function registerOpenAIResponsesProvider(): void {
  registerProvider('openai-responses', () => new OpenAIResponsesProvider())
}
