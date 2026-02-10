import { nanoid } from 'nanoid'
import { parse as parsePartialJSON } from 'partial-json'
import type { UnifiedMessage, ContentBlock, ToolUseBlock } from '../api/types'
import { createProvider } from '../api/provider'
import { toolRegistry } from './tool-registry'
import type { AgentEvent, AgentLoopConfig, ToolCallState } from './types'
import type { ToolContext } from '../tools/tool-types'

/**
 * Core Agentic Loop - an AsyncGenerator that yields AgentEvents.
 *
 * Flow: Send to LLM → Parse Stream → If tool calls → Execute → Append results → Loop
 * UI layer consumes events and updates stores accordingly.
 */
export async function* runAgentLoop(
  messages: UnifiedMessage[],
  config: AgentLoopConfig,
  toolCtx: ToolContext,
  onApprovalNeeded?: (tc: ToolCallState) => Promise<boolean>
): AsyncGenerator<AgentEvent> {
  yield { type: 'loop_start' }

  const provider = createProvider(config.provider)
  const conversationMessages = [...messages]
  let iteration = 0

  while (iteration < config.maxIterations) {
    if (config.signal.aborted) {
      yield { type: 'loop_end', reason: 'aborted' }
      return
    }

    // Drain message queue: inject messages received between turns
    // (e.g. from lead or other teammates via teamEvents)
    if (config.messageQueue) {
      const injected = config.messageQueue.drain()
      for (const msg of injected) {
        conversationMessages.push(msg)
      }
    }

    iteration++
    yield { type: 'iteration_start', iteration }

    // 1. Send to LLM and collect streaming events
    const assistantContentBlocks: ContentBlock[] = []
    const toolCalls: ToolCallState[] = []
    let currentToolArgs = ''
    let currentToolId = ''
    let currentToolName = ''
    // stopReason from message_end is not used at loop level

    try {
      const stream = provider.sendMessage(
        conversationMessages,
        config.tools,
        config.provider,
        config.signal
      )

      for await (const event of stream) {
        if (config.signal.aborted) {
          yield { type: 'loop_end', reason: 'aborted' }
          return
        }

        switch (event.type) {
          case 'thinking_delta':
            yield { type: 'thinking_delta', thinking: event.thinking! }
            appendThinkingToBlocks(assistantContentBlocks, event.thinking!)
            break

          case 'text_delta':
            yield { type: 'text_delta', text: event.text! }
            // Accumulate text into content blocks
            appendTextToBlocks(assistantContentBlocks, event.text!)
            break

          case 'tool_call_start':
            currentToolId = event.toolCallId!
            currentToolName = event.toolName!
            currentToolArgs = ''
            // Immediately notify UI so it can render the tool card while args stream
            yield { type: 'tool_use_streaming_start', toolCallId: currentToolId, toolName: currentToolName }
            break

          case 'tool_call_delta':
            currentToolArgs += event.argumentsDelta ?? ''
            // Try partial-json parse so UI can show args in real-time
            try {
              const partial = parsePartialJSON(currentToolArgs)
              if (partial && typeof partial === 'object' && !Array.isArray(partial)) {
                yield { type: 'tool_use_args_delta', toolCallId: currentToolId, partialInput: partial as Record<string, unknown> }
              }
            } catch { /* incomplete JSON not yet parsable — skip */ }
            break

          case 'tool_call_end': {
            const toolInput = event.toolCallInput ?? safeParseJSON(currentToolArgs)
            const toolUseBlock: ToolUseBlock = {
              type: 'tool_use',
              id: currentToolId || nanoid(),
              name: currentToolName,
              input: toolInput,
            }
            assistantContentBlocks.push(toolUseBlock)

            const requiresApproval = toolRegistry.checkRequiresApproval(
              currentToolName,
              toolInput,
              toolCtx
            )

            const tc: ToolCallState = {
              id: toolUseBlock.id,
              name: currentToolName,
              input: toolInput,
              status: requiresApproval ? 'pending_approval' : 'running',
              requiresApproval,
            }
            toolCalls.push(tc)
            yield { type: 'tool_use_generated', toolUseBlock: { id: toolUseBlock.id, name: currentToolName, input: toolInput } }
            break
          }

          case 'message_end':
            if (event.usage) {
              yield { type: 'message_end', usage: event.usage }
            }
            break

          case 'error':
            yield {
              type: 'error',
              error: new Error(event.error?.message ?? 'Unknown API error'),
            }
            yield { type: 'loop_end', reason: 'error' }
            return
        }
      }
    } catch (err) {
      if (config.signal.aborted) {
        yield { type: 'loop_end', reason: 'aborted' }
        return
      }
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
      yield { type: 'loop_end', reason: 'error' }
      return
    }

    // Push assistant message to conversation
    const assistantMsg: UnifiedMessage = {
      id: nanoid(),
      role: 'assistant',
      content: assistantContentBlocks.length > 0 ? assistantContentBlocks : '',
      createdAt: Date.now(),
    }
    conversationMessages.push(assistantMsg)

    // 2. No tool calls → done
    if (toolCalls.length === 0) {
      yield { type: 'loop_end', reason: 'completed' }
      return
    }

    // 3. Execute tool calls
    const toolResults: ContentBlock[] = []

    for (const tc of toolCalls) {
      // Approval check
      if (tc.requiresApproval && onApprovalNeeded) {
        yield { type: 'tool_call_approval_needed', toolCall: { ...tc } }
        const approved = await onApprovalNeeded(tc)
        if (!approved) {
          yield { type: 'tool_call_result', toolCall: { ...tc, status: 'error', error: 'User denied permission' } }
          toolResults.push({
            type: 'tool_result',
            toolUseId: tc.id,
            content: 'Permission denied by user',
            isError: true,
          })
          continue
        }
      }

      const startedAt = Date.now()
      yield { type: 'tool_call_start', toolCall: { ...tc, status: 'running', startedAt } }

      const output = await toolRegistry.execute(tc.name, tc.input, { ...toolCtx, currentToolUseId: tc.id })

      yield { type: 'tool_call_result', toolCall: { ...tc, status: 'completed', output, startedAt, completedAt: Date.now() } }

      toolResults.push({
        type: 'tool_result',
        toolUseId: tc.id,
        content: output,
      })
    }

    // 4. Append tool results as user message and loop
    const toolResultMsg: UnifiedMessage = {
      id: nanoid(),
      role: 'user',
      content: toolResults,
      createdAt: Date.now(),
    }
    conversationMessages.push(toolResultMsg)

    // Notify UI about tool results so it can sync to chat store
    yield {
      type: 'iteration_end',
      stopReason: 'tool_use',
      toolResults: toolResults
        .filter((b) => b.type === 'tool_result')
        .map((b) => ({ toolUseId: (b as { toolUseId: string }).toolUseId, content: (b as { content: string }).content, isError: (b as { isError?: boolean }).isError })),
    }
  }

  yield { type: 'loop_end', reason: 'max_iterations' }
}

// --- Helpers ---

function appendThinkingToBlocks(blocks: ContentBlock[], thinking: string): void {
  const last = blocks[blocks.length - 1]
  if (last && last.type === 'thinking') {
    last.thinking += thinking
  } else {
    blocks.push({ type: 'thinking', thinking })
  }
}

function appendTextToBlocks(blocks: ContentBlock[], text: string): void {
  const last = blocks[blocks.length - 1]
  if (last && last.type === 'text') {
    last.text += text
  } else {
    blocks.push({ type: 'text', text })
  }
}

function safeParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str)
  } catch {
    return {}
  }
}
