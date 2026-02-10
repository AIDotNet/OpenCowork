import { nanoid } from 'nanoid'
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

    iteration++
    yield { type: 'iteration_start', iteration }

    // 1. Send to LLM and collect streaming events
    const assistantContentBlocks: ContentBlock[] = []
    const toolCalls: ToolCallState[] = []
    let currentToolArgs = ''
    let currentToolId = ''
    let currentToolName = ''
    let stopReason = ''

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
          case 'text_delta':
            yield { type: 'text_delta', text: event.text! }
            // Accumulate text into content blocks
            appendTextToBlocks(assistantContentBlocks, event.text!)
            break

          case 'tool_call_start':
            currentToolId = event.toolCallId!
            currentToolName = event.toolName!
            currentToolArgs = ''
            break

          case 'tool_call_delta':
            currentToolArgs += event.argumentsDelta ?? ''
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
            break
          }

          case 'message_end':
            stopReason = event.stopReason ?? ''
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

    yield { type: 'iteration_end', stopReason }

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

      const output = await toolRegistry.execute(tc.name, tc.input, toolCtx)

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
  }

  yield { type: 'loop_end', reason: 'max_iterations' }
}

// --- Helpers ---

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
