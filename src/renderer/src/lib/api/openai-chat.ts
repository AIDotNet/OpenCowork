import type {
  APIProvider,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage,
  ContentBlock,
} from './types'
import { ipcStreamRequest } from '../ipc/api-stream'
import { registerProvider } from './provider'

class OpenAIChatProvider implements APIProvider {
  readonly name = 'OpenAI Chat Completions'
  readonly type = 'openai-chat' as const

  async *sendMessage(
    messages: UnifiedMessage[],
    tools: ToolDefinition[],
    config: ProviderConfig,
    signal?: AbortSignal
  ): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: this.formatMessages(messages, config.systemPrompt),
      stream: true,
      stream_options: { include_usage: true },
    }

    if (tools.length > 0) {
      body.tools = this.formatTools(tools)
      body.tool_choice = 'auto'
    }
    if (config.temperature !== undefined) body.temperature = config.temperature
    if (config.maxTokens) body.max_tokens = config.maxTokens

    const baseUrl = (config.baseUrl || 'https://api.openai.com').trim().replace(/\/+$/, '')
    const url = `${baseUrl}/v1/chat/completions`

    const toolBuffers = new Map<number, { id: string; name: string; args: string }>()

    for await (const sse of ipcStreamRequest({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })) {
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
          yield {
            type: 'message_end',
            usage: {
              inputTokens: data.usage.prompt_tokens ?? 0,
              outputTokens: data.usage.completion_tokens ?? 0,
              ...(data.usage.completion_tokens_details?.reasoning_tokens
                ? { reasoningTokens: data.usage.completion_tokens_details.reasoning_tokens }
                : {}),
            },
          }
        }
        continue
      }

      const delta = choice.delta

      if (delta?.reasoning_content) {
        yield { type: 'thinking_delta', thinking: delta.reasoning_content }
      }

      if (delta?.content) {
        yield { type: 'text_delta', text: delta.content }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          if (tc.id) {
            toolBuffers.set(idx, { id: tc.id, name: tc.function?.name ?? '', args: '' })
            yield { type: 'tool_call_start', toolCallId: tc.id, toolName: tc.function?.name }
          }
          if (tc.function?.arguments) {
            const buf = toolBuffers.get(idx)!
            buf.args += tc.function.arguments
            yield { type: 'tool_call_delta', argumentsDelta: tc.function.arguments }
          }
        }
      }

      if (choice.finish_reason === 'tool_calls') {
        for (const [, buf] of toolBuffers) {
          try {
            yield { type: 'tool_call_end', toolCallInput: JSON.parse(buf.args) }
          } catch {
            yield { type: 'tool_call_end', toolCallInput: {} }
          }
        }
        toolBuffers.clear()
      }

      if (choice.finish_reason === 'stop') {
        yield { type: 'message_end', stopReason: 'stop' }
      }
    }
  }

  formatMessages(messages: UnifiedMessage[], systemPrompt?: string): unknown[] {
    const formatted: unknown[] = []

    if (systemPrompt) {
      formatted.push({ role: 'system', content: systemPrompt })
    }

    for (const m of messages) {
      if (m.role === 'system') continue

      if (typeof m.content === 'string') {
        formatted.push({ role: m.role, content: m.content })
        continue
      }

      const blocks = m.content as ContentBlock[]

      // Handle tool results → role: "tool"
      const toolResults = blocks.filter((b) => b.type === 'tool_result')
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          if (tr.type === 'tool_result') {
            formatted.push({
              role: 'tool',
              tool_call_id: tr.toolUseId,
              content: tr.content,
            })
          }
        }
        continue
      }

      // Handle assistant with tool_use blocks
      const toolUses = blocks.filter((b) => b.type === 'tool_use')
      const textBlocks = blocks.filter((b) => b.type === 'text')
      const textContent = textBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('')

      if (toolUses.length > 0) {
        formatted.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolUses.map((tu) => {
            if (tu.type !== 'tool_use') return null
            return {
              id: tu.id,
              type: 'function',
              function: { name: tu.name, arguments: JSON.stringify(tu.input) },
            }
          }).filter(Boolean),
        })
      } else {
        formatted.push({ role: m.role, content: textContent })
      }
    }

    return formatted
  }

  formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))
  }
}

export function registerOpenAIChatProvider(): void {
  registerProvider('openai-chat', () => new OpenAIChatProvider())
}
