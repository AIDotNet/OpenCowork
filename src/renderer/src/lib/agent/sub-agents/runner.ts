import { nanoid } from 'nanoid'
import { createProvider } from '../../api/provider'
import { runAgentLoop } from '../agent-loop'
import { toolRegistry } from '../tool-registry'
import type { AgentLoopConfig } from '../types'
import type {
  UnifiedMessage,
  ProviderConfig,
  TokenUsage,
  ToolResultContent,
  ToolDefinition,
  ContentBlock
} from '../../api/types'
import type { ToolHandler } from '../../tools/tool-types'
import type { SubAgentRunConfig, SubAgentResult } from './types'
import { createSubAgentPromptMessage, buildSubAgentPromptText } from './input-message'

export const SUB_AGENT_REPORT_TOOL_NAME = 'SubAgentWriteReport'

const REPORT_ACKNOWLEDGEMENT = 'Final report saved.'
const READ_ONLY_SET = new Set(['Read', 'LS', 'Glob', 'Grep', 'TaskList', 'TaskGet', 'Skill'])

interface ReportCaptureState {
  called: boolean
  report: string
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
  const onParentAbort = (): void => innerAbort.abort()
  toolContext.signal.addEventListener('abort', onParentAbort, { once: true })

  const promptMessage = createSubAgentPromptMessage(input)
  onEvent?.({
    type: 'sub_agent_start',
    subAgentName: definition.name,
    toolUseId,
    input,
    promptMessage
  })

  const allDefs = toolRegistry.getDefinitions()
  const allowedSet = new Set(definition.allowedTools)
  allowedSet.add('Skill')
  const innerTools = allDefs.filter((t) => allowedSet.has(t.name))

  const reportCapture: ReportCaptureState = { called: false, report: '' }
  const reportTool = createReportToolHandler(reportCapture, definition.name, toolUseId, onEvent)
  const availableTools: ToolDefinition[] = [...innerTools, reportTool.definition]

  const innerProvider: ProviderConfig = {
    ...parentProvider,
    systemPrompt: definition.systemPrompt,
    model: definition.model ?? parentProvider.model,
    temperature: definition.temperature ?? parentProvider.temperature
  }

  const systemPrompt = definition.systemPrompt
  const summaryContextParts: string[] = [`## Task Input\n${String(promptMessage.content)}`]

  const loopConfig: AgentLoopConfig = {
    maxIterations: definition.maxIterations,
    provider: innerProvider,
    tools: availableTools,
    systemPrompt,
    workingFolder: toolContext.workingFolder,
    signal: innerAbort.signal
  }

  const loopToolContext = {
    ...toolContext,
    localToolHandlers: {
      ...(toolContext.localToolHandlers ?? {}),
      [SUB_AGENT_REPORT_TOOL_NAME]: reportTool
    }
  }

  let output = ''
  let toolCallCount = 0
  let iterations = 0
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  const buildResult = async (
    success: boolean,
    status: 'completed' | 'failed' | 'aborted',
    error?: string
  ): Promise<SubAgentResult> => {
    const finalOutput = success
      ? definition.formatOutput
        ? definition.formatOutput({
            success,
            output,
            toolCallCount,
            iterations,
            usage: totalUsage,
            finalReportMarkdown: reportCapture.report,
            reportSubmitted: !!reportCapture.report.trim()
          })
        : output
      : ''

    const finalReportMarkdown = await resolveFinalReport({
      providerConfig: innerProvider,
      toolContext: loopToolContext,
      subAgentName: definition.name,
      toolUseId,
      taskInput: buildSubAgentPromptText(input),
      contextParts: summaryContextParts,
      finalOutput: finalOutput || output,
      existingReport: reportCapture.report,
      reportCalled: reportCapture.called,
      status,
      error,
      onEvent,
      retryIteration: iterations + 1
    })

    return {
      success,
      output: success ? finalOutput : '',
      finalReportMarkdown,
      reportSubmitted: !!finalReportMarkdown.trim(),
      reportRetried: !reportCapture.report.trim(),
      toolCallCount,
      iterations,
      usage: totalUsage,
      error
    }
  }

  try {
    const loop = runAgentLoop([promptMessage], loopConfig, loopToolContext, async (tc) => {
      if (isReadOnly(tc.name)) return true
      if (onApprovalNeeded) return onApprovalNeeded(tc)
      return false
    })

    for await (const event of loop) {
      if (toolContext.signal.aborted) {
        innerAbort.abort()
        break
      }

      switch (event.type) {
        case 'iteration_start': {
          iterations = event.iteration
          onEvent?.({
            type: 'sub_agent_iteration',
            subAgentName: definition.name,
            toolUseId,
            iteration: event.iteration,
            assistantMessage: {
              id: nanoid(),
              role: 'assistant',
              content: '',
              createdAt: Date.now()
            }
          })
          break
        }

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
          output += event.text
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
          if (event.usage) {
            mergeUsage(totalUsage, event.usage)
          }
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
          if (event.type === 'tool_call_result') {
            toolCallCount += 1
            if (event.toolCall.name !== SUB_AGENT_REPORT_TOOL_NAME) {
              summaryContextParts.push(formatToolCallSummary(event.toolCall))
            }
          }
          onEvent?.({
            type: 'sub_agent_tool_call',
            subAgentName: definition.name,
            toolUseId,
            toolCall: event.toolCall
          })
          break

        case 'iteration_end': {
          if (event.toolResults && event.toolResults.length > 0) {
            const toolResultMessage = buildToolResultMessage(event.toolResults)
            onEvent?.({
              type: 'sub_agent_tool_result_message',
              subAgentName: definition.name,
              toolUseId,
              message: toolResultMessage
            })
          }
          break
        }

        case 'error': {
          innerAbort.abort()
          const result = await buildResult(false, 'failed', event.error.message)
          onEvent?.({ type: 'sub_agent_end', subAgentName: definition.name, toolUseId, result })
          return result
        }
      }
    }
  } catch (err) {
    innerAbort.abort()
    const errMsg = err instanceof Error ? err.message : String(err)
    const result = await buildResult(false, 'failed', errMsg)
    onEvent?.({ type: 'sub_agent_end', subAgentName: definition.name, toolUseId, result })
    return result
  } finally {
    innerAbort.abort()
    toolContext.signal.removeEventListener('abort', onParentAbort)
  }

  const result = await buildResult(true, toolContext.signal.aborted ? 'aborted' : 'completed')
  onEvent?.({ type: 'sub_agent_end', subAgentName: definition.name, toolUseId, result })
  return result
}

function createReportToolHandler(
  capture: ReportCaptureState,
  subAgentName: string,
  toolUseId: string,
  onEvent?: SubAgentRunConfig['onEvent']
): ToolHandler {
  return {
    definition: {
      name: SUB_AGENT_REPORT_TOOL_NAME,
      description:
        'Submit the final task report. Call this exactly once when the task is complete. Provide a complete Markdown report in the single string field `report`.',
      inputSchema: {
        type: 'object',
        properties: {
          report: {
            type: 'string',
            description: 'Complete Markdown report content for the finished task.'
          }
        },
        required: ['report'],
        additionalProperties: false
      }
    },
    execute: async (input) => {
      const report = typeof input.report === 'string' ? input.report : ''
      capture.called = true
      capture.report = report.trim()
      onEvent?.({
        type: 'sub_agent_report_update',
        subAgentName,
        toolUseId,
        report,
        status: report.trim() ? 'submitted' : 'missing'
      })
      return report.trim() ? REPORT_ACKNOWLEDGEMENT : 'Report was empty.'
    },
    requiresApproval: () => false
  }
}

function isReadOnly(toolName: string): boolean {
  return READ_ONLY_SET.has(toolName)
}

function mergeUsage(target: TokenUsage, usage: TokenUsage): void {
  target.inputTokens += usage.inputTokens
  target.outputTokens += usage.outputTokens
  if (usage.billableInputTokens != null) {
    target.billableInputTokens = (target.billableInputTokens ?? 0) + usage.billableInputTokens
  }
  if (usage.cacheCreationTokens) {
    target.cacheCreationTokens = (target.cacheCreationTokens ?? 0) + usage.cacheCreationTokens
  }
  if (usage.cacheReadTokens) {
    target.cacheReadTokens = (target.cacheReadTokens ?? 0) + usage.cacheReadTokens
  }
  if (usage.reasoningTokens) {
    target.reasoningTokens = (target.reasoningTokens ?? 0) + usage.reasoningTokens
  }
}

function buildToolResultMessage(
  toolResults: { toolUseId: string; content: ToolResultContent; isError?: boolean }[]
): UnifiedMessage {
  const content: ContentBlock[] = toolResults.map((result) => ({
    type: 'tool_result',
    toolUseId: result.toolUseId,
    content: result.content,
    ...(result.isError ? { isError: true } : {})
  }))

  return {
    id: nanoid(),
    role: 'user',
    content,
    createdAt: Date.now()
  }
}

async function resolveFinalReport(options: {
  providerConfig: ProviderConfig
  toolContext: SubAgentRunConfig['toolContext']
  subAgentName: string
  toolUseId: string
  taskInput: string
  contextParts: string[]
  finalOutput: string
  existingReport: string
  reportCalled: boolean
  status: 'completed' | 'failed' | 'aborted'
  error?: string
  onEvent?: SubAgentRunConfig['onEvent']
  retryIteration: number
}): Promise<string> {
  const {
    providerConfig,
    toolContext,
    subAgentName,
    toolUseId,
    taskInput,
    contextParts,
    finalOutput,
    existingReport,
    reportCalled,
    status,
    error,
    onEvent,
    retryIteration
  } = options

  if (existingReport.trim()) {
    onEvent?.({
      type: 'sub_agent_report_update',
      subAgentName,
      toolUseId,
      report: existingReport,
      status: 'submitted'
    })
    return existingReport.trim()
  }

  const retryPrompt = buildRetryReportPrompt({ taskInput, finalOutput, status, error })
  const retryPromptMessage: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: retryPrompt,
    createdAt: Date.now()
  }

  onEvent?.({
    type: 'sub_agent_report_update',
    subAgentName,
    toolUseId,
    report: '',
    status: reportCalled ? 'retrying' : 'fallback'
  })
  onEvent?.({
    type: 'sub_agent_user_message',
    subAgentName,
    toolUseId,
    message: retryPromptMessage
  })
  onEvent?.({
    type: 'sub_agent_iteration',
    subAgentName,
    toolUseId,
    iteration: retryIteration,
    assistantMessage: {
      id: nanoid(),
      role: 'assistant',
      content: '',
      createdAt: Date.now()
    }
  })

  const report = await generateFinalMarkdownReport({
    providerConfig,
    toolContext,
    taskInput,
    contextParts,
    finalOutput,
    status,
    error,
    retryPrompt
  })

  onEvent?.({
    type: 'sub_agent_text_delta',
    subAgentName,
    toolUseId,
    text: report
  })
  onEvent?.({
    type: 'sub_agent_message_end',
    subAgentName,
    toolUseId
  })
  onEvent?.({
    type: 'sub_agent_report_update',
    subAgentName,
    toolUseId,
    report,
    status: 'fallback'
  })

  return report.trim()
}

function buildRetryReportPrompt(options: {
  taskInput: string
  finalOutput: string
  status: 'completed' | 'failed' | 'aborted'
  error?: string
}): string {
  return [
    'Please generate a complete professional final report for the task you just executed.',
    'Write in detailed engineering English and base the report strictly on the actual work that was completed.',
    'Do not invent facts, files, tools, outcomes, or conclusions.',
    'The report must clearly cover the task objective, execution process, key actions, important results, files or artifacts touched, risks or limitations, and recommended next steps.',
    'Return the full report in Markdown.',
    '',
    `Execution status: ${options.status}`,
    options.error ? `Error detail: ${options.error}` : '',
    'Original task input:',
    options.taskInput,
    '',
    'Captured final output:',
    options.finalOutput || '(empty)'
  ]
    .filter(Boolean)
    .join('\n')
}

async function generateFinalMarkdownReport(options: {
  providerConfig: ProviderConfig
  toolContext: SubAgentRunConfig['toolContext']
  taskInput: string
  contextParts: string[]
  finalOutput: string
  status: 'completed' | 'failed' | 'aborted'
  error?: string
  retryPrompt?: string
}): Promise<string> {
  const {
    providerConfig,
    toolContext,
    taskInput,
    contextParts,
    finalOutput,
    status,
    error,
    retryPrompt
  } = options
  const provider = createProvider(providerConfig)
  const prompt = [
    retryPrompt ??
      'Produce a professional final task report in Markdown based strictly on the execution evidence provided below.',
    'Do not fabricate actions, files, findings, rationale, risks, or unresolved items.',
    'Write in clear, concise, engineering-oriented English.',
    'Use exactly the following section headings and preserve this order:',
    '# Task Summary',
    '## Objective',
    '## Outcome',
    '## Actions Taken',
    '## Files and Artifacts',
    '## Key Findings',
    '## Decision Rationale',
    '## Risks and Limitations',
    '## Open Questions',
    '## Recommended Next Steps',
    '',
    `Execution Status: ${status}`,
    error ? `Error Detail: ${error}` : '',
    `Original Task Input:\n${taskInput}`,
    contextParts.join('\n\n'),
    `\n## Final Output\n${finalOutput || '(empty)'}`
  ]
    .filter(Boolean)
    .join('\n')

  const messages: UnifiedMessage[] = [
    {
      id: nanoid(),
      role: 'user',
      content: prompt,
      createdAt: Date.now()
    }
  ]

  let report = ''
  try {
    const stream = provider.sendMessage(messages, [], { ...providerConfig }, toolContext.signal)
    for await (const event of stream) {
      if (toolContext.signal.aborted) break
      if (event.type === 'text_delta' && event.text) report += event.text
    }
  } catch {
    report = ''
  }

  if (report.trim()) return report.trim()

  return [
    '# Task Summary',
    '## Objective',
    taskInput,
    '## Outcome',
    status,
    '## Actions Taken',
    finalOutput || '- No execution output was captured.',
    '## Files and Artifacts',
    '- Summary generation failed, so a complete artifact extraction is unavailable.',
    '## Key Findings',
    error ? `- ${error}` : '- No additional findings captured.',
    '## Decision Rationale',
    '- The reporting stage failed, so this fallback summary only reflects minimally available evidence.',
    '## Risks and Limitations',
    '- This report was generated by fallback logic instead of the dedicated reporting pass.',
    '## Open Questions',
    '- Manual review may be required to inspect the detailed execution trace.',
    '## Recommended Next Steps',
    '- Re-run the task or review the execution trace manually if a higher-confidence report is required.'
  ].join('\n')
}

function formatToolCallSummary(toolCall: {
  name: string
  input: Record<string, unknown>
  status: string
  output?: unknown
  error?: string
}): string {
  const renderedOutput =
    typeof toolCall.output === 'string'
      ? toolCall.output
      : toolCall.output
        ? JSON.stringify(toolCall.output)
        : ''

  return [
    `## Tool Call: ${toolCall.name}`,
    `- Status: ${toolCall.status}`,
    `- Input: ${JSON.stringify(toolCall.input)}`,
    renderedOutput ? `- Output: ${renderedOutput}` : '',
    toolCall.error ? `- Error: ${toolCall.error}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}
