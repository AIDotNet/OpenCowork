import { nanoid } from 'nanoid'
import { Allow, parse as parsePartialJSON } from 'partial-json'
import type { UnifiedMessage, ContentBlock, ToolUseBlock, ToolResultContent } from '../api/types'
import { createProvider } from '../api/provider'
import { toolRegistry } from './tool-registry'
import type { AgentEvent, AgentLoopConfig, ToolCallState } from './types'
import type { ToolContext } from '../tools/tool-types'
import { shouldCompress, shouldPreCompress, preCompressMessages } from './context-compression'

const MAX_PROVIDER_RETRIES = 3
const BASE_RETRY_DELAY_MS = 1_500

class ProviderRequestError extends Error {
  statusCode?: number
  errorType?: string

  constructor(message: string, options?: { statusCode?: number; type?: string }) {
    super(message)
    this.name = 'ProviderRequestError'
    this.statusCode = options?.statusCode
    this.errorType = options?.type
  }
}

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
  let conversationMessages = [...messages]
  let iteration = 0
  let lastInputTokens = 0
  const hasIterationLimit = Number.isFinite(config.maxIterations) && config.maxIterations > 0

  while (!hasIterationLimit || iteration < config.maxIterations) {
    // --- Context management (between iterations) ---
    if (lastInputTokens > 0 && config.contextCompression && !config.signal.aborted) {
      const cc = config.contextCompression
      if (shouldCompress(lastInputTokens, cc.config)) {
        // Full compression: summarize middle history via main model
        yield { type: 'context_compression_start' }
        try {
          const originalCount = conversationMessages.length
          const compressedMessages = await cc.compressFn(conversationMessages)
          // Keep loop-local history mutable even if external stores freeze shared arrays.
          conversationMessages = [...compressedMessages]
          yield {
            type: 'context_compressed',
            originalCount,
            newCount: conversationMessages.length
          }
          lastInputTokens = 0
        } catch (compErr) {
          console.error('[Agent Loop] Context compression failed:', compErr)
        }
      } else if (shouldPreCompress(lastInputTokens, cc.config)) {
        // Lightweight pre-compression: clear stale tool results + thinking blocks (no API call)
        conversationMessages = [...preCompressMessages(conversationMessages)]
      }
    }
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

    // 1. Send to LLM and collect streaming events (with retries)
    let assistantContentBlocks: ContentBlock[] = []
    let toolCalls: ToolCallState[] = []
    let sendAttempt = 0
    // stopReason from message_end is not used at loop level

    while (sendAttempt < MAX_PROVIDER_RETRIES) {
      assistantContentBlocks = []
      toolCalls = []
      const toolArgsById = new Map<string, string>()
      const toolNamesById = new Map<string, string>()
      let currentToolId = ''
      let currentToolName = ''
      let streamedContent = false

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
              streamedContent = true
              yield { type: 'thinking_delta', thinking: event.thinking! }
              appendThinkingToBlocks(assistantContentBlocks, event.thinking!)
              break

            case 'text_delta':
              streamedContent = true
              yield { type: 'text_delta', text: event.text! }
              // Accumulate text into content blocks
              appendTextToBlocks(assistantContentBlocks, event.text!)
              break

            case 'tool_call_start':
              streamedContent = true
              currentToolId = event.toolCallId!
              currentToolName = event.toolName!
              if (currentToolId) {
                toolArgsById.set(currentToolId, '')
                toolNamesById.set(currentToolId, currentToolName)
              }
              // Immediately notify UI so it can render the tool card while args stream
              yield { type: 'tool_use_streaming_start', toolCallId: currentToolId, toolName: currentToolName }
              break

            case 'tool_call_delta':
              streamedContent = true
              {
                const targetToolId = event.toolCallId || currentToolId
                if (!targetToolId) break
                const nextArgs = `${toolArgsById.get(targetToolId) ?? ''}${event.argumentsDelta ?? ''}`
                toolArgsById.set(targetToolId, nextArgs)
                const targetToolName = toolNamesById.get(targetToolId) || currentToolName
                const partialInput = parseToolInputSnapshot(nextArgs, targetToolName)
                if (partialInput && Object.keys(partialInput).length > 0) {
                  yield {
                    type: 'tool_use_args_delta',
                    toolCallId: targetToolId,
                    partialInput,
                  }
                }
              }
              break

            case 'tool_call_end': {
              streamedContent = true
              const endToolId = event.toolCallId || currentToolId || nanoid()
              const endToolName = event.toolName || currentToolName
              const rawToolArgs = toolArgsById.get(endToolId) ?? ''
              const streamedToolInput = parseToolInputSnapshot(rawToolArgs, endToolName)
              const mergedToolInput = mergeToolInputs(streamedToolInput, event.toolCallInput)
              const toolInput =
                Object.keys(mergedToolInput).length > 0 ? mergedToolInput : safeParseJSON(rawToolArgs)
              const toolUseBlock: ToolUseBlock = {
                type: 'tool_use',
                id: endToolId,
                name: endToolName,
                input: toolInput,
              }
              assistantContentBlocks.push(toolUseBlock)
              toolArgsById.delete(endToolId)
              toolNamesById.delete(endToolId)

              const requiresApproval = config.forceApproval || toolRegistry.checkRequiresApproval(
                endToolName,
                toolInput,
                toolCtx
              )

              const tc: ToolCallState = {
                id: toolUseBlock.id,
                name: endToolName,
                input: toolInput,
                status: requiresApproval ? 'pending_approval' : 'running',
                requiresApproval,
              }
              toolCalls.push(tc)
              yield { type: 'tool_use_generated', toolUseBlock: { id: toolUseBlock.id, name: endToolName, input: toolInput } }
              break;
            }

            case 'message_end':
              if (event.usage) {
                lastInputTokens = event.usage.inputTokens
              }
              if (event.usage || event.timing) {
                yield { type: 'message_end', usage: event.usage, timing: event.timing }
              }
              break

            case 'request_debug':
              if (event.debugInfo) {
                yield { type: 'request_debug', debugInfo: event.debugInfo }
              }
              break

            case 'error':
              throw new ProviderRequestError(event.error?.message ?? 'Unknown API error', {
                type: event.error?.type,
              })
          }
        }

        // Defensive: some providers may occasionally miss explicit tool_call_end.
        // Finalize any dangling tool calls so UI/state can transition out of streaming.
        if (toolArgsById.size > 0) {
          for (const [danglingToolId, argsText] of toolArgsById) {
            const danglingName = toolNamesById.get(danglingToolId) || currentToolName
            const danglingInput = parseToolInputSnapshot(argsText, danglingName) ?? safeParseJSON(argsText)
            const requiresApproval = config.forceApproval || toolRegistry.checkRequiresApproval(
              danglingName,
              danglingInput,
              toolCtx
            )
            const toolUseBlock: ToolUseBlock = {
              type: 'tool_use',
              id: danglingToolId,
              name: danglingName,
              input: danglingInput,
            }
            assistantContentBlocks.push(toolUseBlock)
            toolCalls.push({
              id: danglingToolId,
              name: danglingName,
              input: danglingInput,
              status: requiresApproval ? 'pending_approval' : 'running',
              requiresApproval,
            })
            yield {
              type: 'tool_use_generated',
              toolUseBlock: { id: danglingToolId, name: danglingName, input: danglingInput },
            }
          }
          toolArgsById.clear()
          toolNamesById.clear()
        }

        // Successful attempt, break retry loop
        break
      } catch (err) {
        if (config.signal.aborted) {
          yield { type: 'loop_end', reason: 'aborted' }
          return
        }
        const delay = getRetryDelay(err, sendAttempt, streamedContent)
        if (delay === null || sendAttempt === MAX_PROVIDER_RETRIES - 1) {
          yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
          yield { type: 'loop_end', reason: 'error' }
          return
        }
        sendAttempt++
        try {
          await delayWithAbort(delay, config.signal)
        } catch {
          yield { type: 'loop_end', reason: 'aborted' }
          return
        }
        continue
      }
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
          if (config.signal.aborted) {
            yield { type: 'loop_end', reason: 'aborted' }
            return
          }
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

      let output: ToolResultContent
      let toolError: string | undefined
      try {
        output = await toolRegistry.execute(tc.name, tc.input, { ...toolCtx, currentToolUseId: tc.id })
      } catch (toolErr) {
        if (config.signal.aborted) {
          yield { type: 'loop_end', reason: 'aborted' }
          return
        }
        const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr)
        toolError = errMsg
        output = JSON.stringify({ error: errMsg })
      }

      if (config.signal.aborted) {
        yield { type: 'loop_end', reason: 'aborted' }
        return
      }

      yield {
        type: 'tool_call_result',
        toolCall: {
          ...tc,
          status: toolError ? 'error' : 'completed',
          output,
          ...(toolError ? { error: toolError } : {}),
          startedAt,
          completedAt: Date.now()
        }
      }

      toolResults.push({
        type: 'tool_result',
        toolUseId: tc.id,
        content: output,
        ...(toolError ? { isError: true } : {}),
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
        .map((b) => ({ toolUseId: (b as { toolUseId: string }).toolUseId, content: (b as { content: ToolResultContent }).content, isError: (b as { isError?: boolean }).isError })),
    }
  }

  if (hasIterationLimit) {
    yield { type: 'loop_end', reason: 'max_iterations' }
  } else {
    yield { type: 'loop_end', reason: 'completed' }
  }
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

function parseToolInputSnapshot(rawArgs: string, toolName: string): Record<string, unknown> | null {
  const isWriteTool = toolName === 'Write'
  const looseWriteInput = isWriteTool ? parseWriteInputLoosely(rawArgs) : null

  try {
    const parsed = parsePartialJSON(rawArgs, Allow.ALL)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const normalizedParsed = normalizeParsedToolInput(parsed as Record<string, unknown>)
      if (looseWriteInput && Object.keys(looseWriteInput).length > 0) {
        return { ...looseWriteInput, ...normalizedParsed }
      }
      return normalizedParsed
    }
  } catch {
    // Fall through to tool-specific tolerant parsing.
  }

  if (looseWriteInput && Object.keys(looseWriteInput).length > 0) {
    return looseWriteInput
  }

  return null
}

function normalizeParsedToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const args = input.args
  if (
    args &&
    typeof args === 'object' &&
    !Array.isArray(args) &&
    Object.keys(input).every((key) => key === 'args')
  ) {
    return args as Record<string, unknown>
  }
  return input
}

function mergeToolInputs(
  streamedInput: Record<string, unknown> | null,
  providerInput?: Record<string, unknown>
): Record<string, unknown> {
  const normalizedProviderInput =
    providerInput && typeof providerInput === 'object' && !Array.isArray(providerInput)
      ? normalizeParsedToolInput(providerInput)
      : {}

  if (streamedInput && Object.keys(streamedInput).length > 0) {
    return { ...streamedInput, ...normalizedProviderInput }
  }
  return normalizedProviderInput
}

function parseWriteInputLoosely(rawArgs: string): Record<string, unknown> | null {
  const filePath =
    readLooseJsonStringField(rawArgs, 'file_path') ?? readLooseJsonStringField(rawArgs, 'path')
  const content = readLooseJsonStringField(rawArgs, 'content')

  const input: Record<string, unknown> = {}
  if (filePath !== null) input.file_path = filePath
  if (content !== null) input.content = content
  return Object.keys(input).length > 0 ? input : null
}

function readLooseJsonStringField(raw: string, key: string): string | null {
  const keyPattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"`)
  const match = keyPattern.exec(raw)
  if (!match) return null

  let idx = match.index + match[0].length
  let value = ''
  let escaped = false

  while (idx < raw.length) {
    const ch = raw[idx]

    if (escaped) {
      switch (ch) {
        case 'n':
          value += '\n'
          break
        case 'r':
          value += '\r'
          break
        case 't':
          value += '\t'
          break
        case '"':
          value += '"'
          break
        case '\\':
          value += '\\'
          break
        default:
          value += ch
          break
      }
      escaped = false
      idx++
      continue
    }

    if (ch === '\\') {
      escaped = true
      idx++
      continue
    }

    if (ch === '"') return value

    value += ch
    idx++
  }

  if (escaped) value += '\\'
  return value
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getRetryDelay(err: unknown, attempt: number, streamedContent: boolean): number | null {
  const status = extractStatusCode(err)

  if (status === 429) {
    return BASE_RETRY_DELAY_MS * Math.pow(2, attempt + 1)
  }

  if (status && status >= 400 && status < 500) {
    // Non-retryable client errors
    return null
  }

  if (status && status >= 500) {
    return BASE_RETRY_DELAY_MS * Math.pow(2, attempt)
  }

  // If the provider didn't stream anything before failing, treat it as transient
  if (!streamedContent) {
    return BASE_RETRY_DELAY_MS * Math.pow(2, attempt)
  }

  // Default small backoff for partial streams
  return BASE_RETRY_DELAY_MS
}

function extractStatusCode(err: unknown): number | null {
  if (err instanceof ProviderRequestError && typeof err.statusCode === 'number') {
    return err.statusCode
  }

  const message = err instanceof Error ? err.message : String(err)
  const match = /HTTP\s+(\d{3})/i.exec(message)
  if (match) {
    const code = Number(match[1])
    return Number.isFinite(code) ? code : null
  }

  return null
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }

    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(new Error('aborted'))
    }

    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
