import { nanoid } from 'nanoid'
import { toolRegistry } from '../tool-registry'
import type { AgentLoopConfig } from '../types'
import { MessageQueue } from '../types'
import type { ProviderConfig, UnifiedMessage } from '../../api/types'
import type { SubAgentRunConfig, SubAgentResult } from './types'
import { createSubAgentPromptMessage } from './input-message'
import { buildRuntimeCompression } from '../context-compression-runtime'
import { resolveSubAgentTools } from './resolve-tools'
import {
  buildToolResultMessage,
  requestFallbackReport,
  runSharedAgentRuntime
} from '../shared-runtime'
import { registerInlineToolHandlers } from '../../ipc/inline-tool-handler-registry'
import {
  clearSubmittedReportForRun,
  createSubmitReportTool,
  SUBMIT_REPORT_TOOL_NAME
} from './submit-report-tool'
import { resolveSubAgentMaxTurns } from './limits'
import { useProviderStore } from '../../../stores/provider-store'
import { useSettingsStore } from '../../../stores/settings-store'

const READ_ONLY_SET = new Set([
  'Read',
  'LS',
  'Glob',
  'Grep',
  'TaskList',
  'TaskGet',
  'Skill',
  SUBMIT_REPORT_TOOL_NAME
])

const activeSubAgentRuns = new Map<
  string,
  {
    subAgentName: string
    queue: MessageQueue
    abortController: AbortController
    onEvent?: SubAgentRunConfig['onEvent']
  }
>()

export function appendSubAgentUserMessage(toolUseId: string, message: UnifiedMessage): boolean {
  const run = activeSubAgentRuns.get(toolUseId)
  if (!run || run.abortController.signal.aborted) return false

  run.queue.push(message)
  run.onEvent?.({
    type: 'sub_agent_user_message',
    subAgentName: run.subAgentName,
    toolUseId,
    message
  })
  return true
}

export function abortSubAgentRun(toolUseId: string): boolean {
  const run = activeSubAgentRuns.get(toolUseId)
  if (!run || run.abortController.signal.aborted) return false
  run.abortController.abort()
  return true
}

function hasUsableProviderConfig(
  provider: ProviderConfig | null | undefined
): provider is ProviderConfig {
  return Boolean(provider && (provider.apiKey || provider.requiresApiKey === false))
}

function resolveSubAgentProviderConfig(
  parentProvider: ProviderConfig,
  definition: SubAgentRunConfig['definition']
): ProviderConfig {
  const providerStore = useProviderStore.getState()
  const settings = useSettingsStore.getState()
  const fastProvider = providerStore.getFastProviderConfig()
  const baseProvider = hasUsableProviderConfig(fastProvider) ? fastProvider : parentProvider
  const modelOverride = definition.model?.trim()
  const model = modelOverride || baseProvider.model

  return {
    ...baseProvider,
    systemPrompt: definition.systemPrompt,
    model,
    maxTokens: providerStore.getEffectiveMaxTokens(settings.maxTokens, model),
    temperature: definition.temperature ?? settings.temperature ?? baseProvider.temperature,
    ...(baseProvider.sessionId || parentProvider.sessionId
      ? { sessionId: baseProvider.sessionId ?? parentProvider.sessionId }
      : {}),
    ...(baseProvider.responsesSessionScope || parentProvider.responsesSessionScope
      ? {
          responsesSessionScope:
            baseProvider.responsesSessionScope ?? parentProvider.responsesSessionScope
        }
      : {})
  }
}

/**
 * Run a SubAgent — executes an inner agent loop with a focused system prompt
 * and restricted tool set, then returns a consolidated result.
 *
 * SubAgents auto-approve read-only tools. Write tools bubble approval up
 * to the parent via onApprovalNeeded callback.
 */
export async function runSubAgent(config: SubAgentRunConfig): Promise<SubAgentResult> {
  const { definition, parentProvider, toolContext, input, toolUseId, onEvent, onApprovalNeeded } =
    config

  const innerAbort = new AbortController()
  const messageQueue = new MessageQueue()
  const onParentAbort = (): void => innerAbort.abort()
  toolContext.signal.addEventListener('abort', onParentAbort, { once: true })
  activeSubAgentRuns.set(toolUseId, {
    subAgentName: definition.name,
    queue: messageQueue,
    abortController: innerAbort,
    onEvent
  })

  const promptMessage = createSubAgentPromptMessage(input, Date.now(), definition.initialPrompt)
  onEvent?.({
    type: 'sub_agent_start',
    subAgentName: definition.name,
    toolUseId,
    input,
    promptMessage
  })

  const { tools: resolvedInnerTools, invalidTools } = resolveSubAgentTools(
    definition,
    toolRegistry.getDefinitions()
  )

  // Inject the SubmitReport tool so the sub-agent can explicitly end its own
  // session with a report payload. Without this, some models keep calling
  // tools indefinitely after the task is logically done, or stop emitting
  // tool calls without ever producing visible text — both leave the parent
  // agent with no usable result.
  const sidecarRunId = `subagent-${nanoid()}`
  const submitReportTool = createSubmitReportTool(sidecarRunId)
  const unregisterSubmitReportHandler = registerInlineToolHandlers(sidecarRunId, {
    [submitReportTool.name]: submitReportTool.handler
  })
  const innerTools =
    resolvedInnerTools.length > 0 ? [...resolvedInnerTools, submitReportTool.definition] : []

  const innerProvider = resolveSubAgentProviderConfig(parentProvider, definition)

  const compression = buildRuntimeCompression(innerProvider, innerAbort.signal)

  const loopConfig: AgentLoopConfig = {
    maxIterations: resolveSubAgentMaxTurns(definition.maxTurns),
    provider: innerProvider,
    tools: innerTools,
    systemPrompt: definition.systemPrompt,
    workingFolder: toolContext.workingFolder,
    signal: innerAbort.signal,
    messageQueue,
    ...(compression ? { contextCompression: compression } : {})
  }

  const loopToolContext = {
    ...toolContext,
    signal: innerAbort.signal,
    callerAgent: definition.name,
    inlineToolHandlers: {
      ...(toolContext.inlineToolHandlers ?? {}),
      [submitReportTool.name]: submitReportTool.handler
    }
  }

  const invalidToolsSuffix = invalidTools.length
    ? ` Unavailable tools: ${invalidTools.join(', ')}.`
    : ''

  const buildResult = (
    success: boolean,
    runtime: {
      finalOutput: string
      aggregatedText: string
      toolCallCount: number
      iterations: number
      usage: SubAgentResult['usage']
    },
    error?: string
  ): SubAgentResult => {
    const baseOutput = success
      ? runtime.finalOutput
      : runtime.finalOutput || runtime.aggregatedText.trim()
    const output =
      success && definition.formatOutput
        ? definition.formatOutput({
            success: true,
            output: baseOutput,
            reportSubmitted: !!baseOutput.trim(),
            toolCallCount: runtime.toolCallCount,
            iterations: runtime.iterations,
            usage: runtime.usage
          })
        : baseOutput
    const hasOutput = !!output.trim()

    onEvent?.({
      type: 'sub_agent_report_update',
      subAgentName: definition.name,
      toolUseId,
      report: output,
      status: hasOutput ? 'submitted' : 'missing'
    })

    return {
      success,
      output,
      reportSubmitted: hasOutput,
      toolCallCount: runtime.toolCallCount,
      iterations: runtime.iterations,
      usage: runtime.usage,
      ...(error ? { error } : {})
    }
  }

  const readReportFromInput = (input: Record<string, unknown> | undefined): string | null => {
    const report = typeof input?.report === 'string' ? input.report.trim() : ''
    return report ? report : null
  }

  const readSubmittedReportFromToolCalls = (
    toolCalls: Array<{ name: string; input: Record<string, unknown> }>
  ): string | null => {
    for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
      const toolCall = toolCalls[index]
      if (toolCall.name !== SUBMIT_REPORT_TOOL_NAME) continue
      const report = readReportFromInput(toolCall.input)
      if (report) return report
    }
    return null
  }

  try {
    if (innerTools.length === 0) {
      const result = buildResult(
        false,
        {
          finalOutput: '',
          aggregatedText: '',
          toolCallCount: 0,
          iterations: 0,
          usage: { inputTokens: 0, outputTokens: 0 }
        },
        `No tools available for sub-agent.${invalidTools.length > 0 ? ` Requested: ${invalidTools.join(', ')}` : ''}`
      )
      onEvent?.({ type: 'sub_agent_end', subAgentName: definition.name, toolUseId, result })
      return result
    }

    const runtime = await runSharedAgentRuntime({
      runId: sidecarRunId,
      initialMessages: [promptMessage],
      loopConfig,
      toolContext: loopToolContext,
      isReadOnlyTool: (toolName) => READ_ONLY_SET.has(toolName),
      onApprovalNeeded,
      hooks: {
        afterHandleEvent: async ({ event, state }) => {
          switch (event.type) {
            case 'iteration_start':
              onEvent?.({
                type: 'sub_agent_iteration',
                subAgentName: definition.name,
                toolUseId,
                iteration: state.iteration,
                assistantMessage: {
                  id: nanoid(),
                  role: 'assistant',
                  content: '',
                  createdAt: Date.now()
                }
              })
              break

            case 'thinking_delta':
              onEvent?.({
                type: 'sub_agent_thinking_delta',
                subAgentName: definition.name,
                toolUseId,
                thinking: event.thinking
              })
              break

            case 'thinking_encrypted':
              onEvent?.({
                type: 'sub_agent_thinking_encrypted',
                subAgentName: definition.name,
                toolUseId,
                thinkingEncryptedContent: event.thinkingEncryptedContent,
                thinkingEncryptedProvider: event.thinkingEncryptedProvider
              })
              break

            case 'text_delta':
              onEvent?.({
                type: 'sub_agent_text_delta',
                subAgentName: definition.name,
                toolUseId,
                text: event.text
              })
              break

            case 'image_generated':
              onEvent?.({
                type: 'sub_agent_image_generated',
                subAgentName: definition.name,
                toolUseId,
                imageBlock: event.imageBlock
              })
              break

            case 'image_error':
              onEvent?.({
                type: 'sub_agent_image_error',
                subAgentName: definition.name,
                toolUseId,
                imageError: event.imageError
              })
              break

            case 'tool_use_streaming_start':
              onEvent?.({
                type: 'sub_agent_tool_use_streaming_start',
                subAgentName: definition.name,
                toolUseId,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                toolCallExtraContent: event.toolCallExtraContent
              })
              break

            case 'tool_use_args_delta':
              onEvent?.({
                type: 'sub_agent_tool_use_args_delta',
                subAgentName: definition.name,
                toolUseId,
                toolCallId: event.toolCallId,
                partialInput: event.partialInput
              })
              break

            case 'tool_use_generated':
              onEvent?.({
                type: 'sub_agent_tool_use_generated',
                subAgentName: definition.name,
                toolUseId,
                toolUseBlock: {
                  type: 'tool_use',
                  id: event.toolUseBlock.id,
                  name: event.toolUseBlock.name,
                  input: event.toolUseBlock.input,
                  ...(event.toolUseBlock.extraContent
                    ? { extraContent: event.toolUseBlock.extraContent }
                    : {})
                }
              })
              break

            case 'message_end':
              onEvent?.({
                type: 'sub_agent_message_end',
                subAgentName: definition.name,
                toolUseId,
                usage: event.usage,
                providerResponseId: event.providerResponseId
              })
              break

            case 'tool_call_start':
            case 'tool_call_result':
              onEvent?.({
                type: 'sub_agent_tool_call',
                subAgentName: definition.name,
                toolUseId,
                toolCall: event.toolCall
              })
              // If SubmitReport has just completed, stop immediately — we
              // don't need to wait for any other tools in the same batch or
              // for the iteration wrap-up. This is what flips the card from
              // "in progress" to "done" as soon as the report is submitted.
              if (
                event.type === 'tool_call_result' &&
                event.toolCall.name === SUBMIT_REPORT_TOOL_NAME &&
                (submitReportTool.getReport() !== null ||
                  readReportFromInput(event.toolCall.input) !== null)
              ) {
                return { stop: true, reason: 'completed' }
              }
              break

            case 'iteration_end':
              if (event.toolResults && event.toolResults.length > 0) {
                onEvent?.({
                  type: 'sub_agent_tool_result_message',
                  subAgentName: definition.name,
                  toolUseId,
                  message: buildToolResultMessage(event.toolResults)
                })
              }
              // Safety net: if SubmitReport fired but we missed the early
              // exit (e.g. hook ordering), stop here before the next iteration.
              if (submitReportTool.getReport() !== null) {
                return { stop: true, reason: 'completed' }
              }
              break
          }
          return undefined
        }
      }
    })

    const error = runtime.error ? `${runtime.error}${invalidToolsSuffix}` : undefined
    const success = runtime.reason !== 'error' && runtime.reason !== 'aborted'

    // Primary path: the model called SubmitReport and gave us an explicit
    // report payload — always prefer this over scraped assistant text.
    const submittedReport =
      submitReportTool.getReport() ?? readSubmittedReportFromToolCalls(runtime.toolCalls)
    let effectiveRuntime = runtime
    if (submittedReport && submittedReport.trim()) {
      effectiveRuntime = { ...runtime, finalOutput: submittedReport.trim() }
    } else if (
      !runtime.finalOutput.trim() &&
      runtime.finalMessages.length > 0 &&
      !innerAbort.signal.aborted
    ) {
      // Fallback: the loop ended without a submitted report and without any
      // assistant text. Replay the transcript with a synthetic "generate a
      // detailed report" user message so the caller always gets a usable
      // summary instead of an empty string.
      const fallback = await requestFallbackReport({
        capturedMessages: runtime.finalMessages,
        loopConfig,
        toolContext: loopToolContext
      })
      if (fallback) {
        effectiveRuntime = { ...runtime, finalOutput: fallback }
      }
    }

    const result = buildResult(success, effectiveRuntime, error)
    onEvent?.({ type: 'sub_agent_end', subAgentName: definition.name, toolUseId, result })
    return result
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const result = buildResult(
      false,
      {
        finalOutput: '',
        aggregatedText: '',
        toolCallCount: 0,
        iterations: 0,
        usage: { inputTokens: 0, outputTokens: 0 }
      },
      `${errMsg}${invalidToolsSuffix}`
    )
    onEvent?.({ type: 'sub_agent_end', subAgentName: definition.name, toolUseId, result })
    return result
  } finally {
    const activeRun = activeSubAgentRuns.get(toolUseId)
    if (activeRun?.abortController === innerAbort) {
      activeSubAgentRuns.delete(toolUseId)
    }
    unregisterSubmitReportHandler()
    clearSubmittedReportForRun(sidecarRunId)
    innerAbort.abort()
    toolContext.signal.removeEventListener('abort', onParentAbort)
  }
}
