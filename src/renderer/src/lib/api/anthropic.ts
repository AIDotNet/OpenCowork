import type {
  APIProvider,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage,
  ContentBlock,
  TokenUsage,
} from './types'
import { ipcStreamRequest } from '../ipc/api-stream'
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
    const body = {
      model: config.model,
      max_tokens: config.maxTokens ?? 32000,
      ...(config.systemPrompt ? { system: config.systemPrompt } : {}),
      messages: this.formatMessages(messages),
      ...(tools.length > 0 ? { tools: this.formatTools(tools), tool_choice: { type: 'auto' } } : {}),
      stream: true,
    }

    const baseUrl = (config.baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '')
    const url = `${baseUrl}/v1/messages`

    let toolInputBuffer = ''
    // Anthropic splits usage across two events:
    // - message_start → input_tokens, cache_creation_input_tokens, cache_read_input_tokens
    // - message_delta → output_tokens
    // We accumulate the message_start usage and merge it into message_end.
    const pendingUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

    for await (const sse of ipcStreamRequest({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
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

        case 'content_block_start':
          if (data.content_block.type === 'tool_use') {
            toolInputBuffer = ''
            yield {
              type: 'tool_call_start',
              toolCallId: data.content_block.id,
              toolName: data.content_block.name,
            }
          }
          // thinking blocks are handled via their deltas
          break

        case 'content_block_delta':
          if (data.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: data.delta.text }
          } else if (data.delta.type === 'thinking_delta') {
            yield { type: 'thinking_delta', thinking: data.delta.thinking }
          } else if (data.delta.type === 'input_json_delta') {
            toolInputBuffer += data.delta.partial_json
            yield { type: 'tool_call_delta', argumentsDelta: data.delta.partial_json }
          }
          break

        case 'content_block_stop':
          if (toolInputBuffer) {
            try {
              yield { type: 'tool_call_end', toolCallInput: JSON.parse(toolInputBuffer) }
            } catch {
              yield { type: 'tool_call_end', toolCallInput: {} }
            }
            toolInputBuffer = ''
          }
          break

        case 'message_delta':
          pendingUsage.outputTokens = data.usage?.output_tokens ?? 0
          yield {
            type: 'message_end',
            stopReason: data.delta.stop_reason,
            usage: { ...pendingUsage },
          }
          break

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
                return { type: 'thinking', thinking: b.thinking }
              case 'text':
                return { type: 'text', text: b.text }
              case 'tool_use':
                return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
              case 'tool_result':
                return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content }
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
