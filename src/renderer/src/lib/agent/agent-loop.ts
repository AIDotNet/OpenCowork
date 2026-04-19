import { nanoid } from 'nanoid'
import { Allow, parse as parsePartialJSON } from 'partial-json'
import type {
  UnifiedMessage,
  ContentBlock,
  ToolUseBlock,
  ToolResultContent,
  ToolCallExtraContent
} from '../api/types'
import { createProvider } from '../api/provider'
import { toolRegistry } from './tool-registry'
import type { AgentEvent, AgentLoopConfig, ToolCallState } from './types'
import type { ToolContext, ToolHandler } from '../tools/tool-types'
import { decodeStructuredToolResult, encodeToolError } from '../tools/tool-result-format'
import {
  summarizeToolInputForHistory,
  sanitizeMessagesForToolReplay
} from '../tools/tool-input-sanitizer'
import {
  resetCompressionFailures,
  shouldCompress,
  shouldPreCompress,
  preCompressMessages
} from './context-compression'
import { trySwitchProviderAccount } from '../auth/provider-auth'
import { ConcurrencyLimiter } from './concurrency-limiter'

const MAX_PROVIDER_RETRIES = 3
const BASE_RETRY_DELAY_MS = 1_500
const DEFAULT_MAX_PARALLEL_TOOLS = 8

function isAwaitingUserReviewToolResult(output: ToolResultContent): boolean {
  if (typeof output !== 'string') return false
  const parsed = decodeStructuredToolResult(output)
  return (
    !!parsed &&
    !Array.isArray(parsed) &&
    parsed.awaiting_user_review === true &&
    parsed.status === 'awaiting_review'
  )
}

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

function readContextUsage(usage?: UnifiedMessage['usage']): number {
  return usage?.contextTokens ?? usage?.inputTokens ?? 0
}

function findRecentContextUsage(messages: UnifiedMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = readContextUsage(messages[i]?.usage)
    if (tokens > 0) return tokens
  }
  return 0
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

  console.log('[Agent Loop] Initial provider config:', {
    type: config.provider.type,
    model: config.provider.model,
    baseUrl: config.provider.baseUrl
  })
  let conversationMessages = [...messages]
  let iteration = 0
  if (config.contextCompression) {
    resetCompressionFailures()
  }
  let lastInputTokens = config.contextCompression ? findRecentContextUsage(messages) : 0
  const hasIterationLimit = Number.isFinite(config.maxIterations) && config.maxIterations > 0

  // Always hand the final transcript back to the caller so it can replay the
  // conversation (e.g. generate a fallback report when no text was produced).
  // Using a generator-level try/finally guarantees the callback fires for
  // completed runs, errors, and early termination via .return().
  try {
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
      let accountFailoverUsed = false
      let providerResponseId: string | undefined
      // stopReason from message_end is not used at loop level

      while (sendAttempt < MAX_PROVIDER_RETRIES) {
        assistantContentBlocks = []
        toolCalls = []
        const toolArgChunksById = new Map<string, string[]>()
        const toolArgsLenById = new Map<string, number>()
        const toolNamesById = new Map<string, string>()
        const toolExtraContentById = new Map<string, ToolCallExtraContent>()
        let currentToolId = ''
        let currentToolName = ''
        let streamedContent = false

        try {
          const resolvedProviderConfig = config.resolveProvider
            ? await config.resolveProvider(conversationMessages)
            : config.provider
          const provider = createProvider(resolvedProviderConfig)

          const stream = provider.sendMessage(
            conversationMessages,
            config.tools,
            resolvedProviderConfig,
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

              case 'thinking_encrypted':
                if (event.thinkingEncryptedContent && event.thinkingEncryptedProvider) {
                  streamedContent = true
                  yield {
                    type: 'thinking_encrypted',
                    thinkingEncryptedContent: event.thinkingEncryptedContent,
                    thinkingEncryptedProvider: event.thinkingEncryptedProvider
                  }
                  appendThinkingEncryptedToBlocks(
                    assistantContentBlocks,
                    event.thinkingEncryptedContent,
                    event.thinkingEncryptedProvider
                  )
                }
                break

              case 'text_delta':
                streamedContent = true
                yield { type: 'text_delta', text: event.text! }
                // Accumulate text into content blocks
                appendTextToBlocks(assistantContentBlocks, event.text!)
                break

              case 'image_generated':
                streamedContent = true
                if (event.imageBlock) {
                  assistantContentBlocks.push(event.imageBlock)
                  yield { type: 'image_generated', imageBlock: event.imageBlock }
                }
                break

              case 'image_error':
                streamedContent = true
                if (event.imageError) {
                  assistantContentBlocks.push({
                    type: 'image_error',
                    code: event.imageError.code,
                    message: event.imageError.message
                  })
                  yield { type: 'image_error', imageError: event.imageError }
                }
                break

              case 'tool_call_start':
                streamedContent = true
                currentToolId = event.toolCallId!
                currentToolName = event.toolName!
                if (currentToolId) {
                  toolArgChunksById.set(currentToolId, [])
                  toolArgsLenById.set(currentToolId, 0)
                  toolNamesById.set(currentToolId, currentToolName)
                  if (event.toolCallExtraContent) {
                    toolExtraContentById.set(currentToolId, event.toolCallExtraContent)
                  }
                }
                // Immediately notify UI so it can render the tool card while args stream
                yield {
                  type: 'tool_use_streaming_start',
                  toolCallId: currentToolId,
                  toolName: currentToolName,
                  ...(event.toolCallExtraContent
                    ? { toolCallExtraContent: event.toolCallExtraContent }
                    : {})
                }
                break

              case 'tool_call_delta':
                streamedContent = true
                {
                  const targetToolId = event.toolCallId || currentToolId
                  if (!targetToolId) break
                  const delta = event.argumentsDelta ?? ''
                  const chunks = toolArgChunksById.get(targetToolId)
                  if (chunks) {
                    chunks.push(delta)
                  } else {
                    toolArgChunksById.set(targetToolId, [delta])
                  }
                  const newLen = (toolArgsLenById.get(targetToolId) ?? 0) + delta.length
                  toolArgsLenById.set(targetToolId, newLen)

                  const targetToolName = toolNamesById.get(targetToolId) || currentToolName

                  // For Write/Edit, only parse the first few deltas to extract
                  // file_path for the UI card. Skip all subsequent parsing —
                  // the full content is parsed once at tool_call_end.
                  // This avoids sending growing file content through the
                  // entire event→store→render pipeline on every delta.
                  if (targetToolName === 'Edit') {
                    break
                  }

                  if (targetToolName === 'Write' && newLen > 200) {
                    break
                  }

                  const nextArgs = chunks ? chunks.join('') : delta
                  const partialInput = parseToolInputSnapshot(nextArgs, targetToolName)
                  if (partialInput && Object.keys(partialInput).length > 0) {
                    yield {
                      type: 'tool_use_args_delta',
                      toolCallId: targetToolId,
                      partialInput
                    }
                  }
                }
                break

              case 'tool_call_end': {
                streamedContent = true
                const endToolId = event.toolCallId || currentToolId || nanoid()
                const endToolName = event.toolName || currentToolName
                const rawToolArgs = (toolArgChunksById.get(endToolId) ?? []).join('')
                const streamedToolInput = parseToolInputSnapshot(rawToolArgs, endToolName)
                const mergedToolInput = mergeToolInputs(streamedToolInput, event.toolCallInput)
                const toolInput =
                  Object.keys(mergedToolInput).length > 0
                    ? mergedToolInput
                    : safeParseJSON(rawToolArgs)
                const historyToolInput = summarizeToolInputForHistory(endToolName, toolInput)
                const toolUseBlock: ToolUseBlock = {
                  type: 'tool_use',
                  id: endToolId,
                  name: endToolName,
                  input: historyToolInput,
                  extraContent: event.toolCallExtraContent ?? toolExtraContentById.get(endToolId)
                }
                assistantContentBlocks.push(toolUseBlock)
                toolArgChunksById.delete(endToolId)
                toolArgsLenById.delete(endToolId)
                toolNamesById.delete(endToolId)
                toolExtraContentById.delete(endToolId)

                const requiresApproval =
                  config.forceApproval || checkToolRequiresApproval(endToolName, toolInput, toolCtx)

                const tc: ToolCallState = {
                  id: toolUseBlock.id,
                  name: endToolName,
                  input: toolInput,
                  status: requiresApproval ? 'pending_approval' : 'running',
                  requiresApproval,
                  ...(toolUseBlock.extraContent ? { extraContent: toolUseBlock.extraContent } : {})
                }
                toolCalls.push(tc)
                yield {
                  type: 'tool_use_generated',
                  toolUseBlock: {
                    id: toolUseBlock.id,
                    name: endToolName,
                    input: historyToolInput,
                    ...(toolUseBlock.extraContent
                      ? { extraContent: toolUseBlock.extraContent }
                      : {})
                  }
                }
                break
              }

              case 'message_end':
                if (event.usage) {
                  lastInputTokens = readContextUsage(event.usage)
                }
                if (event.providerResponseId) {
                  providerResponseId = event.providerResponseId
                }
                if (event.usage || event.timing || event.providerResponseId || event.stopReason) {
                  yield {
                    type: 'message_end',
                    usage: event.usage,
                    timing: event.timing,
                    providerResponseId: event.providerResponseId,
                    stopReason: event.stopReason
                  }
                }
                break

              case 'request_debug':
                if (event.debugInfo) {
                  yield {
                    type: 'request_debug',
                    debugInfo: {
                      ...event.debugInfo,
                      providerId: resolvedProviderConfig.providerId,
                      providerBuiltinId: resolvedProviderConfig.providerBuiltinId,
                      model: resolvedProviderConfig.model
                    }
                  }
                }
                break

              case 'error':
                throw new ProviderRequestError(event.error?.message ?? 'Unknown API error', {
                  type: event.error?.type
                })
            }
          }

          // Defensive: some providers may occasionally miss explicit tool_call_end.
          // Finalize any dangling tool calls so UI/state can transition out of streaming.
          if (toolArgChunksById.size > 0) {
            for (const [danglingToolId, chunks] of toolArgChunksById) {
              const argsText = chunks.join('')
              const danglingName = toolNamesById.get(danglingToolId) || currentToolName
              const danglingInput =
                parseToolInputSnapshot(argsText, danglingName) ?? safeParseJSON(argsText)
              const requiresApproval =
                config.forceApproval ||
                checkToolRequiresApproval(danglingName, danglingInput, toolCtx)
              const historyDanglingInput = summarizeToolInputForHistory(danglingName, danglingInput)
              const toolUseBlock: ToolUseBlock = {
                type: 'tool_use',
                id: danglingToolId,
                name: danglingName,
                input: historyDanglingInput,
                extraContent: toolExtraContentById.get(danglingToolId)
              }
              assistantContentBlocks.push(toolUseBlock)
              toolCalls.push({
                id: danglingToolId,
                name: danglingName,
                input: danglingInput,
                status: requiresApproval ? 'pending_approval' : 'running',
                requiresApproval
              })
              yield {
                type: 'tool_use_generated',
                toolUseBlock: {
                  id: danglingToolId,
                  name: danglingName,
                  input: historyDanglingInput
                }
              }
            }
            toolArgChunksById.clear()
            toolArgsLenById.clear()
            toolNamesById.clear()
          }

          // Successful attempt, break retry loop
          break
        } catch (err) {
          if (config.signal.aborted) {
            yield { type: 'loop_end', reason: 'aborted' }
            return
          }
          // Multi-account failover: on rate-limit / auth errors, try switching to the
          // next available OAuth account once before giving up. Rate-limit markers
          // from the main process land asynchronously via IPC, so by the time we
          // reach this catch the active account has typically already been flagged.
          if (!accountFailoverUsed && isAccountFailoverCandidate(err)) {
            const resolvedId = await safeResolveProviderId(config)
            if (resolvedId) {
              const switched = trySwitchProviderAccount(resolvedId)
              if (switched) {
                accountFailoverUsed = true
                continue
              }
            }
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
        ...(providerResponseId ? { providerResponseId } : {})
      }
      conversationMessages.push(assistantMsg)
      conversationMessages = sanitizeMessagesForToolReplay(conversationMessages)

      // 2. No tool calls → done
      if (toolCalls.length === 0) {
        yield { type: 'loop_end', reason: 'completed' }
        return
      }

      // 3. Execute tool calls
      const toolResults: Array<ContentBlock | undefined> = new Array(toolCalls.length)
      let shouldStopForUserReview = false
      const runnableToolCalls: Array<{ tc: ToolCallState; index: number }> = []
      const startedAtByToolId = new Map<string, number>()

      const buildToolCallResult = (params: {
        tc: ToolCallState
        index: number
        output: ToolResultContent
        toolError?: string
        startedAt: number
        completedAt: number
      }): {
        resultEvent: ToolCallState
        resultBlock: ContentBlock
      } => {
        const { tc, index, output, toolError, startedAt, completedAt } = params
        const sanitizedInput = summarizeToolInputForHistory(tc.name, tc.input)
        const resultEvent: ToolCallState = {
          ...tc,
          input: sanitizedInput,
          status: toolError ? 'error' : 'completed',
          output,
          ...(toolError ? { error: toolError } : {}),
          startedAt,
          completedAt
        }

        const resultBlock: ContentBlock = {
          type: 'tool_result',
          toolUseId: tc.id,
          content: output,
          ...(toolError ? { isError: true } : {})
        }
        toolResults[index] = resultBlock
        shouldStopForUserReview ||= isAwaitingUserReviewToolResult(output)
        return { resultEvent, resultBlock }
      }

      for (const [index, tc] of toolCalls.entries()) {
        if (tc.requiresApproval && onApprovalNeeded) {
          yield {
            type: 'tool_call_approval_needed',
            toolCall: {
              ...tc,
              input: summarizeToolInputForHistory(tc.name, tc.input)
            }
          }
          const approved = await onApprovalNeeded(tc)
          if (!approved) {
            if (config.signal.aborted) {
              yield { type: 'loop_end', reason: 'aborted' }
              return
            }
            const deniedAt = Date.now()
            const deniedResult = buildToolCallResult({
              tc,
              index,
              output: 'Permission denied by user',
              toolError: 'User denied permission',
              startedAt: deniedAt,
              completedAt: deniedAt
            })
            yield {
              type: 'tool_call_result',
              toolCall: deniedResult.resultEvent
            }
            continue
          }
        }

        const startedAt = Date.now()
        startedAtByToolId.set(tc.id, startedAt)
        yield {
          type: 'tool_call_start',
          toolCall: {
            ...tc,
            input: summarizeToolInputForHistory(tc.name, tc.input),
            status: 'running',
            startedAt
          }
        }
        runnableToolCalls.push({ tc, index })
      }

      const enableParallelToolExecution =
        (config.enableParallelToolExecution ?? true) && runnableToolCalls.length > 1
      const maxParallelTools = Math.max(
        1,
        Math.floor(config.maxParallelTools ?? DEFAULT_MAX_PARALLEL_TOOLS)
      )

      if (enableParallelToolExecution) {
        const limiter = new ConcurrencyLimiter(maxParallelTools)
        const completedExecutions: Array<{
          tc: ToolCallState
          index: number
          output: ToolResultContent
          toolError?: string
          startedAt: number
          completedAt: number
        }> = []
        let wakeExecutions: (() => void) | null = null
        const wake = (): void => {
          if (!wakeExecutions) return
          const notify = wakeExecutions
          wakeExecutions = null
          notify()
        }

        const executionTasks = runnableToolCalls.map(({ tc, index }) =>
          (async () => {
            let output: ToolResultContent
            let toolError: string | undefined
            try {
              await limiter.run(async () => {
                output = await executeTool(tc.name, tc.input, {
                  ...toolCtx,
                  currentToolUseId: tc.id,
                  readFileHistory: toolCtx.readFileHistory
                })
              }, config.signal)
            } catch (toolErr) {
              const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr)
              toolError = errMsg
              output = encodeToolError(errMsg)
            }

            completedExecutions.push({
              tc,
              index,
              output: output!,
              toolError,
              startedAt: startedAtByToolId.get(tc.id) ?? Date.now(),
              completedAt: Date.now()
            })
            wake()
          })()
        )

        let completedCount = 0
        while (completedCount < executionTasks.length) {
          if (completedExecutions.length === 0) {
            await new Promise<void>((resolve) => {
              wakeExecutions = resolve
              if (completedExecutions.length > 0) {
                wake()
              }
            })
            continue
          }

          while (completedExecutions.length > 0) {
            const execution = completedExecutions.shift()
            if (!execution) break
            completedCount += 1
            if (config.signal.aborted) {
              yield { type: 'loop_end', reason: 'aborted' }
              return
            }
            const completedResult = buildToolCallResult(execution)
            yield {
              type: 'tool_call_result',
              toolCall: completedResult.resultEvent
            }
          }
        }

        await Promise.all(executionTasks)
      } else {
        for (const { tc, index } of runnableToolCalls) {
          let output: ToolResultContent
          let toolError: string | undefined
          try {
            output = await executeTool(tc.name, tc.input, {
              ...toolCtx,
              currentToolUseId: tc.id,
              readFileHistory: toolCtx.readFileHistory
            })
          } catch (toolErr) {
            if (config.signal.aborted) {
              yield { type: 'loop_end', reason: 'aborted' }
              return
            }
            const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr)
            toolError = errMsg
            output = encodeToolError(errMsg)
          }

          const completedAt = Date.now()
          if (config.signal.aborted) {
            yield { type: 'loop_end', reason: 'aborted' }
            return
          }

          const completedResult = buildToolCallResult({
            tc,
            index,
            output,
            toolError,
            startedAt: startedAtByToolId.get(tc.id) ?? completedAt,
            completedAt
          })
          yield {
            type: 'tool_call_result',
            toolCall: completedResult.resultEvent
          }
        }
      }

      // 4. Append tool results as user message and loop
      const toolResultMsg: UnifiedMessage = {
        id: nanoid(),
        role: 'user',
        content: toolResults.filter((block): block is ContentBlock => Boolean(block)),
        createdAt: Date.now()
      }
      conversationMessages.push(toolResultMsg)

      // Notify UI about tool results so it can sync to chat store
      yield {
        type: 'iteration_end',
        stopReason: 'tool_use',
        toolResults: toolResults
          .filter(
            (block): block is Extract<ContentBlock, { type: 'tool_result' }> =>
              block !== undefined && block.type === 'tool_result'
          )
          .map((block) => ({
            toolUseId: block.toolUseId,
            content: block.content,
            isError: block.isError
          }))
      }

      if (shouldStopForUserReview) {
        yield { type: 'loop_end', reason: 'completed' }
        return
      }
    }

    if (hasIterationLimit) {
      yield { type: 'loop_end', reason: 'max_iterations' }
    } else {
      yield { type: 'loop_end', reason: 'completed' }
    }
  } finally {
    try {
      config.captureFinalMessages?.([...conversationMessages])
    } catch (captureErr) {
      console.error('[Agent Loop] captureFinalMessages hook threw:', captureErr)
    }
  }
}

// --- Helpers ---

function getToolHandler(name: string, toolCtx: ToolContext): ToolHandler | undefined {
  return toolCtx.inlineToolHandlers?.[name] ?? toolRegistry.get(name)
}

function checkToolRequiresApproval(
  name: string,
  input: Record<string, unknown>,
  toolCtx: ToolContext
): boolean {
  const handler = getToolHandler(name, toolCtx)
  if (!handler) return true
  return handler.requiresApproval?.(input, toolCtx) ?? false
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  toolCtx: ToolContext
): Promise<ToolResultContent> {
  const inlineHandler = toolCtx.inlineToolHandlers?.[name]
  if (inlineHandler) {
    return inlineHandler.execute(input, toolCtx)
  }
  return toolRegistry.execute(name, input, toolCtx)
}

function appendThinkingToBlocks(blocks: ContentBlock[], thinking: string): void {
  const last = blocks[blocks.length - 1]
  if (last && last.type === 'thinking') {
    last.thinking += thinking
  } else {
    blocks.push({ type: 'thinking', thinking })
  }
}

function appendThinkingEncryptedToBlocks(
  blocks: ContentBlock[],
  encryptedContent: string,
  provider: 'anthropic' | 'openai-responses' | 'google'
): void {
  if (!encryptedContent) return

  let target: Extract<ContentBlock, { type: 'thinking' }> | null = null
  let providerMatchedTarget: Extract<ContentBlock, { type: 'thinking' }> | null = null
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.type !== 'thinking') continue

    if (!block.encryptedContent) {
      target = block
      break
    }

    if (!providerMatchedTarget && block.encryptedContentProvider === provider) {
      providerMatchedTarget = block
    }
  }

  if (!target && providerMatchedTarget) {
    target = providerMatchedTarget
  }

  if (target) {
    target.encryptedContent = encryptedContent
    target.encryptedContentProvider = provider
    return
  }

  blocks.push({
    type: 'thinking',
    thinking: '',
    encryptedContent,
    encryptedContentProvider: provider
  })
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

function isAccountFailoverCandidate(err: unknown): boolean {
  const status = extractStatusCode(err)
  if (status === 401 || status === 403 || status === 429) return true
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('quota') ||
    message.includes('auth_error') ||
    message.includes('unauthorized')
  ) {
    return true
  }
  return false
}

async function safeResolveProviderId(config: AgentLoopConfig): Promise<string | undefined> {
  try {
    if (config.resolveProvider) {
      const resolved = await config.resolveProvider([])
      return resolved?.providerId
    }
  } catch {
    return undefined
  }
  return config.provider?.providerId
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
