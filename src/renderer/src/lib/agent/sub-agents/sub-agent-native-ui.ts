import { useAgentStore } from '@renderer/stores/agent-store'
import { backgroundSubAgentCompletions } from './background-events'
import type { SubAgentEvent, SubAgentResult } from './types'
import type { UnifiedMessage } from '../../api/types'

type NativeSubAgentUiUpdateResult = {
  ok: boolean
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readRequiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readEndReason(value: unknown): SubAgentResult['endReason'] | undefined {
  return value === 'completed' ||
    value === 'max_iterations' ||
    value === 'aborted' ||
    value === 'error'
    ? value
    : undefined
}

function readMessages(value: unknown): UnifiedMessage[] | undefined {
  if (!Array.isArray(value)) return undefined
  const messages: UnifiedMessage[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.role !== 'string') continue
    if (
      item.role !== 'system' &&
      item.role !== 'user' &&
      item.role !== 'assistant' &&
      item.role !== 'tool'
    ) {
      continue
    }
    if (typeof item.content !== 'string' && !Array.isArray(item.content)) continue
    messages.push(item as unknown as UnifiedMessage)
  }
  return messages.length > 0 ? messages : undefined
}

function parseResult(value: unknown): SubAgentResult | null {
  if (!isRecord(value) || !isRecord(value.usage)) return null
  const endReason = readEndReason(value.endReason)
  const messages = readMessages(value.messages)

  return {
    success: value.success === true,
    output: typeof value.output === 'string' ? value.output : '',
    reportSubmitted: value.reportSubmitted === true,
    toolCallCount: readNumber(value, 'toolCallCount'),
    iterations: readNumber(value, 'iterations'),
    ...(endReason ? { endReason } : {}),
    ...(messages ? { messages } : {}),
    usage: {
      inputTokens: readNumber(value.usage, 'inputTokens'),
      outputTokens: readNumber(value.usage, 'outputTokens'),
      ...(typeof value.usage.cacheReadTokens === 'number'
        ? { cacheReadTokens: value.usage.cacheReadTokens }
        : {}),
      ...(typeof value.usage.cacheCreationTokens === 'number'
        ? { cacheCreationTokens: value.usage.cacheCreationTokens }
        : {})
    },
    ...(typeof value.error === 'string' && value.error.trim() ? { error: value.error.trim() } : {})
  }
}

function parseProgressEvent(
  value: unknown,
  subAgentName: string,
  toolUseId: string
): SubAgentEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null

  const base = { subAgentName, toolUseId }
  switch (value.type) {
    case 'sub_agent_iteration':
      if (!isRecord(value.assistantMessage)) return null
      return {
        ...base,
        type: value.type,
        iteration: readNumber(value, 'iteration'),
        assistantMessage: value.assistantMessage as unknown as UnifiedMessage
      }
    case 'sub_agent_text_delta':
      return {
        ...base,
        type: value.type,
        text: typeof value.text === 'string' ? value.text : ''
      }
    case 'sub_agent_thinking_delta':
      return {
        ...base,
        type: value.type,
        thinking: typeof value.thinking === 'string' ? value.thinking : ''
      }
    case 'sub_agent_thinking_encrypted':
      if (
        value.thinkingEncryptedProvider !== 'anthropic' &&
        value.thinkingEncryptedProvider !== 'openai-responses' &&
        value.thinkingEncryptedProvider !== 'google'
      ) {
        return null
      }
      return {
        ...base,
        type: value.type,
        thinkingEncryptedContent:
          typeof value.thinkingEncryptedContent === 'string' ? value.thinkingEncryptedContent : '',
        thinkingEncryptedProvider: value.thinkingEncryptedProvider
      }
    case 'sub_agent_tool_use_streaming_start':
      return {
        ...base,
        type: value.type,
        toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : '',
        toolName: typeof value.toolName === 'string' ? value.toolName : '',
        ...(isRecord(value.subAgentToolCallExtraContent)
          ? { toolCallExtraContent: value.subAgentToolCallExtraContent }
          : {})
      }
    case 'sub_agent_tool_use_args_delta':
      return {
        ...base,
        type: value.type,
        toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : '',
        partialInput: isRecord(value.partialInput) ? value.partialInput : {}
      }
    case 'sub_agent_tool_use_generated':
      if (!isRecord(value.toolUseBlock)) return null
      return {
        ...base,
        type: value.type,
        toolUseBlock: value.toolUseBlock as unknown as Extract<
          SubAgentEvent,
          { type: 'sub_agent_tool_use_generated' }
        >['toolUseBlock']
      }
    case 'sub_agent_image_generated':
      if (!isRecord(value.imageBlock)) return null
      return {
        ...base,
        type: value.type,
        imageBlock: value.imageBlock as unknown as Extract<
          SubAgentEvent,
          { type: 'sub_agent_image_generated' }
        >['imageBlock']
      }
    case 'sub_agent_image_error':
      if (!isRecord(value.imageError)) return null
      return {
        ...base,
        type: value.type,
        imageError: value.imageError as unknown as Extract<
          SubAgentEvent,
          { type: 'sub_agent_image_error' }
        >['imageError']
      }
    case 'sub_agent_message_end':
      return {
        ...base,
        type: value.type,
        ...(isRecord(value.usage)
          ? {
              usage: value.usage as unknown as Extract<
                SubAgentEvent,
                { type: 'sub_agent_message_end' }
              >['usage']
            }
          : {}),
        ...(typeof value.providerResponseId === 'string'
          ? { providerResponseId: value.providerResponseId }
          : {}),
        ...(isRecord(value.requestModel)
          ? {
              requestModel: value.requestModel as unknown as Extract<
                SubAgentEvent,
                { type: 'sub_agent_message_end' }
              >['requestModel']
            }
          : {})
      }
    case 'sub_agent_tool_call':
      if (!isRecord(value.toolCall)) return null
      return {
        ...base,
        type: value.type,
        toolCall: value.toolCall as unknown as Extract<
          SubAgentEvent,
          { type: 'sub_agent_tool_call' }
        >['toolCall']
      }
    case 'sub_agent_tool_result_message':
      if (!isRecord(value.eventMessage)) return null
      return {
        ...base,
        type: value.type,
        message: value.eventMessage as unknown as UnifiedMessage
      }
    default:
      return null
  }
}

export async function handleNativeSubAgentUiUpdate(
  params: unknown
): Promise<NativeSubAgentUiUpdateResult> {
  const record = isRecord(params) ? params : {}
  const sessionId = readRequiredString(record, 'sessionId')
  const toolUseId = readRequiredString(record, 'toolUseId')
  const subAgentName = readRequiredString(record, 'subAgentName')
  const displayName = readRequiredString(record, 'displayName') ?? subAgentName

  if (record.action === 'progress') {
    if (!sessionId || !toolUseId || !subAgentName || !Array.isArray(record.events)) {
      return { ok: false, error: 'Invalid native background sub-agent progress payload.' }
    }

    const agentStore = useAgentStore.getState()
    for (const rawEvent of record.events) {
      const event = parseProgressEvent(rawEvent, subAgentName, toolUseId)
      if (event) agentStore.handleSubAgentEvent(event, sessionId)
    }
    return { ok: true }
  }

  if (record.action !== 'completed') {
    return { ok: false, error: 'Unsupported native sub-agent UI action.' }
  }

  const result = parseResult(record.result)
  if (!sessionId || !toolUseId || !subAgentName || !displayName || !result) {
    return { ok: false, error: 'Invalid native background sub-agent completion payload.' }
  }

  const agentStore = useAgentStore.getState()
  agentStore.handleSubAgentEvent(
    {
      type: 'sub_agent_report_update',
      subAgentName,
      toolUseId,
      report: result.output,
      status: result.reportSubmitted ? 'submitted' : 'missing'
    },
    sessionId
  )
  agentStore.handleSubAgentEvent(
    {
      type: 'sub_agent_end',
      subAgentName,
      toolUseId,
      result
    },
    sessionId
  )

  backgroundSubAgentCompletions.emit({
    sessionId,
    toolUseId,
    subAgentName,
    displayName,
    result
  })

  return { ok: true }
}
