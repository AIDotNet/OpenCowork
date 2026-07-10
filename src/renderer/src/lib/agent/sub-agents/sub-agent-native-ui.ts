import { useAgentStore } from '@renderer/stores/agent-store'
import { backgroundSubAgentCompletions } from './background-events'
import type { SubAgentResult } from './types'

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

function parseResult(value: unknown): SubAgentResult | null {
  if (!isRecord(value) || !isRecord(value.usage)) return null

  return {
    success: value.success === true,
    output: typeof value.output === 'string' ? value.output : '',
    reportSubmitted: value.reportSubmitted === true,
    toolCallCount: readNumber(value, 'toolCallCount'),
    iterations: readNumber(value, 'iterations'),
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

export async function handleNativeSubAgentUiUpdate(
  params: unknown
): Promise<NativeSubAgentUiUpdateResult> {
  const record = isRecord(params) ? params : {}
  if (record.action !== 'completed') {
    return { ok: false, error: 'Unsupported native sub-agent UI action.' }
  }

  const sessionId = readRequiredString(record, 'sessionId')
  const toolUseId = readRequiredString(record, 'toolUseId')
  const subAgentName = readRequiredString(record, 'subAgentName')
  const displayName = readRequiredString(record, 'displayName') ?? subAgentName
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
      status: result.output.trim() ? 'submitted' : 'missing'
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
