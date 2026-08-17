import type {
  CloseAgentSessionResult,
  OpenAgentSessionParams,
  OpenAgentSessionResult,
  RuntimeErrorCode,
  SendSessionTurnParams,
  SendSessionTurnResult,
  StartRunParams,
  StartRunResult
} from '../../../shared/runtime-contracts/generated/contracts'
import { assistantMessageIdForRun } from '../../../shared/runtime-projection/reducer'
import type {
  AssembleSessionIntent,
  AssembledSessionContext,
  AssembledWireMessage,
  RunContextAssemblerDeps
} from './run-context-assembler'
import { hostedSessionPrefixIdentity } from './run-context-assembler'
import {
  applyCompactWatermark,
  compactWatermarkFence,
  deriveCompactWatermarkFromTranscript,
  type CompactWatermark,
  type WatermarkMessage
} from '../../../shared/compact-watermark'
import {
  listUnpinnedToolNames,
  buildVolatilePromptTurnContext
} from '../../../shared/agent-system-prompt'

type OpenPrefixState = {
  identity: string
  toolNames: string[]
}

export type AgentSessionServiceDeps = {
  isRunning: () => boolean
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  assemble: (intent: AssembleSessionIntent) => Promise<AssembledSessionContext>
  nextRunId?: () => string
  /**
   * Recorded compaction cut, used to re-apply the cut to renderer-assembled run
   * payloads. Main owns the cut, so it enforces it here rather than trusting
   * whatever view the caller happened to build.
   */
  readCompaction?: (sessionId: string) => Promise<CompactWatermark | null>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readErrorCode(error: unknown): RuntimeErrorCode | null {
  if (error && typeof error === 'object' && 'errorCode' in error) {
    const code = (error as { errorCode?: unknown }).errorCode
    if (code === 'session_evicted') return 'session_evicted'
    if (code === 'worker_interrupted') return 'worker_interrupted'
    if (code === 'protocol_mismatch') return 'protocol_mismatch'
    if (code === 'runtime_expired') return 'runtime_expired'
    if (typeof code === 'string') return 'unknown'
  }
  if (error instanceof Error && error.message.includes('session_evicted')) {
    return 'session_evicted'
  }
  return null
}

function rejectedRun(
  sessionId: string,
  errorCode: RuntimeErrorCode | null,
  runId = ''
): StartRunResult {
  return {
    accepted: false,
    runId,
    sessionId,
    assistantMessageId: '',
    errorCode
  }
}

function acceptedRun(sessionId: string, runId: string, assistantMessageId: string): StartRunResult {
  return {
    accepted: true,
    runId,
    sessionId,
    assistantMessageId,
    errorCode: null
  }
}

// `connection` is re-sent every turn on purpose: the Worker keeps hosted sessions on
// disk across restarts, so pinning SSH credentials to the open template would both
// persist them and keep using stale ones after the user edits the connection.
const SESSION_SEND_TURN_KEYS = [
  'requestContextTexts',
  'planMode',
  'planRevision',
  'planExecution',
  'planModeAllowedTools',
  'commandMetadata',
  'slashCommand',
  'systemCommand',
  'attachmentIds',
  'connection',
  // Per-turn: a reused hosted session keeps the open-time template, so Dev Mode
  // toggled after session-open would otherwise never reach PrepareBodyFile.
  'includeFullDebugBody'
] as const

export class AgentSessionService {
  private readonly deps: AgentSessionServiceDeps
  private readonly openPrefix = new Map<string, OpenPrefixState>()

  constructor(deps: AgentSessionServiceDeps) {
    this.deps = deps
  }

  async openSession(params: OpenAgentSessionParams): Promise<OpenAgentSessionResult> {
    if (!this.deps.isRunning()) {
      return { ok: false, sessionId: params.sessionId, messageCount: 0 }
    }
    try {
      const assembled = await this.deps.assemble({
        sessionId: params.sessionId,
        triggerMessageId: '',
        mode: params.mode,
        providerId: params.providerId,
        modelId: params.modelId,
        attachmentIds: [],
        commandMetadata: params.metadata
      })
      const result = asRecord(
        await this.deps.request(
          'agent/session-open',
          {
            ...omitPinnedCommandFields(assembled.openTemplate),
            messages: [...assembled.historyMessages, ...assembled.turnMessages]
          },
          30_000
        )
      )
      const sessionId = typeof result.sessionId === 'string' ? result.sessionId : params.sessionId
      if (result.ok === true) {
        this.openPrefix.set(sessionId, {
          identity: assembled.prefixIdentity,
          toolNames: readTemplateToolNames(assembled.openTemplate)
        })
      }
      return {
        ok: result.ok === true,
        sessionId,
        messageCount: typeof result.messageCount === 'number' ? result.messageCount : 0
      }
    } catch (error) {
      console.warn('[agent-session-service] session-open failed', {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return { ok: false, sessionId: params.sessionId, messageCount: 0 }
    }
  }

  /**
   * Route a renderer-assembled `agent:run` payload through hosted session-open +
   * session-send. Returns null when the payload is not a session-scoped turn
   * (caller should keep the legacy `agent/run` path).
   */
  async startAssembledRun(
    params: Record<string, unknown>,
    options?: { runId?: string }
  ): Promise<StartRunResult | null> {
    if (!this.deps.isRunning()) return null
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
    if (!sessionId || !isRecord(params.provider)) return null
    if (params.providerTurnOnly === true || params.goalRunSource === 'continue') return null
    if (Array.isArray(params.liveOverlayMessages) && params.liveOverlayMessages.length > 0) {
      return null
    }

    const messages = Array.isArray(params.messages) ? params.messages : []
    const { history, turn } = splitAssembledTurnMessages(messages)
    if (turn.length === 0) return null

    // A session compacted by an older build has no record; its cut is derived
    // from the marker rows the caller still carries so the enforcement below
    // covers legacy sessions too.
    const compaction =
      (await this.deps.readCompaction?.(sessionId)) ??
      deriveCompactWatermarkFromTranscript(history as WatermarkMessage[])

    // Re-apply the recorded cut. The caller assembled this payload from its own
    // view of the transcript; if that view predates the last compaction, sending
    // it as-is is exactly how summarized turns get back into the context window.
    const cutHistory = applyCompactWatermark(history as WatermarkMessage[], compaction)
    if (cutHistory.length !== history.length) {
      console.log('[agent-session-service] Re-applied compaction cut to assembled run', {
        sessionId,
        before: history.length,
        after: cutHistory.length,
        throughSortOrder: compaction?.throughSortOrder ?? null
      })
    }

    const { messages: _messages, runId: _runId, ...template } = params
    const assembled: AssembledSessionContext = {
      openTemplate: { ...template, messages: cutHistory },
      historyMessages: cutHistory as AssembledWireMessage[],
      turnMessages: turn as AssembledWireMessage[],
      prefixIdentity: prefixIdentityFromAssembledParams(params, compaction)
    }

    if (!this.canReuseOpenSession(sessionId, assembled.prefixIdentity)) {
      const opened = await this.openWithTemplate(assembled)
      if (!opened) return rejectedRun(sessionId, 'unknown', options?.runId ?? '')
    }
    return await this.sendTurnMessages(sessionId, assembled, true, options?.runId)
  }

  async startRun(params: StartRunParams): Promise<StartRunResult> {
    if (!this.deps.isRunning()) {
      return rejectedRun(params.sessionId, 'unknown')
    }
    let assembled: AssembledSessionContext
    try {
      assembled = await this.deps.assemble(toAssembleIntent(params))
    } catch (error) {
      console.warn('[agent-session-service] assemble failed', {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return rejectedRun(params.sessionId, 'unknown')
    }
    if (assembled.turnMessages.length === 0) {
      return rejectedRun(params.sessionId, 'unknown')
    }

    if (!this.canReuseOpenSession(params.sessionId, assembled.prefixIdentity)) {
      const opened = await this.openWithTemplate(assembled)
      if (!opened) return rejectedRun(params.sessionId, 'unknown')
    }
    return await this.sendTurnMessages(params.sessionId, assembled, true)
  }

  async sendTurn(params: SendSessionTurnParams): Promise<SendSessionTurnResult> {
    if (!this.deps.isRunning()) {
      return rejectedRun(params.sessionId, 'unknown')
    }
    let assembled: AssembledSessionContext
    try {
      assembled = await this.deps.assemble({
        sessionId: params.sessionId,
        triggerMessageId: params.triggerMessageId,
        mode: '',
        providerId: '',
        modelId: '',
        attachmentIds: params.attachmentIds,
        commandMetadata: params.commandMetadata
      })
    } catch (error) {
      console.warn('[agent-session-service] assemble failed', {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return rejectedRun(params.sessionId, 'unknown')
    }
    if (assembled.turnMessages.length === 0) {
      return rejectedRun(params.sessionId, 'unknown')
    }
    if (!this.canReuseOpenSession(params.sessionId, assembled.prefixIdentity)) {
      const opened = await this.openWithTemplate(assembled)
      if (!opened) return rejectedRun(params.sessionId, 'unknown')
    }
    return await this.sendTurnMessages(params.sessionId, assembled, true)
  }

  async closeSession(sessionId: string): Promise<CloseAgentSessionResult> {
    this.openPrefix.delete(sessionId)
    if (!this.deps.isRunning()) {
      return { ok: false, sessionId, closed: false }
    }
    const result = asRecord(await this.deps.request('agent/session-close', { sessionId }, 10_000))
    return {
      ok: result.ok === true,
      sessionId: typeof result.sessionId === 'string' ? result.sessionId : sessionId,
      closed: result.closed === true
    }
  }

  private canReuseOpenSession(sessionId: string, prefixIdentity: string): boolean {
    return this.openPrefix.get(sessionId)?.identity === prefixIdentity
  }

  private rememberOpenPrefix(sessionId: string, assembled: AssembledSessionContext): void {
    this.openPrefix.set(sessionId, {
      identity: assembled.prefixIdentity,
      toolNames: readTemplateToolNames(assembled.openTemplate)
    })
  }

  private applyUnpinnedToolReminder(sessionId: string, assembled: AssembledSessionContext): void {
    const pinned = this.openPrefix.get(sessionId)
    if (!pinned) return
    const extra = listUnpinnedToolNames(
      pinned.toolNames,
      readTemplateToolNames(assembled.openTemplate)
    )
    if (extra.length === 0) return
    const existing = Array.isArray(assembled.openTemplate.requestContextTexts)
      ? assembled.openTemplate.requestContextTexts.filter(
          (text): text is string => typeof text === 'string'
        )
      : []
    assembled.openTemplate.requestContextTexts = [
      ...existing,
      ...buildVolatilePromptTurnContext({ unavailableToolNames: extra })
    ]
  }

  private async openWithTemplate(assembled: AssembledSessionContext): Promise<boolean> {
    const result = asRecord(
      await this.deps.request(
        'agent/session-open',
        {
          ...omitPinnedCommandFields(assembled.openTemplate),
          messages: assembled.historyMessages
        },
        30_000
      )
    )
    const sessionId =
      typeof result.sessionId === 'string'
        ? result.sessionId
        : String(assembled.openTemplate.sessionId ?? '')
    if (result.ok === true && sessionId) {
      this.rememberOpenPrefix(sessionId, assembled)
      return true
    }
    if (sessionId) this.openPrefix.delete(sessionId)
    return false
  }

  private async sendTurnMessages(
    sessionId: string,
    assembled: AssembledSessionContext,
    retryOnEvict: boolean,
    runIdOverride?: string
  ): Promise<StartRunResult> {
    const requestedRunId = runIdOverride?.trim() || this.deps.nextRunId?.().trim() || undefined
    const payload: Record<string, unknown> = {
      sessionId,
      messages: assembled.turnMessages
    }
    if (requestedRunId) payload.runId = requestedRunId
    this.applyUnpinnedToolReminder(sessionId, assembled)
    copySessionSendTurnFields(assembled.openTemplate, payload)
    try {
      const result = asRecord(await this.deps.request('agent/session-send', payload, 60_000))
      const accepted = result.started === true || result.accepted === true
      const runId =
        (typeof result.runId === 'string' && result.runId.trim()) || requestedRunId || ''
      if (!accepted) {
        return rejectedRun(sessionId, readErrorCodeFromResult(result), runId)
      }
      const assistantMessageId =
        (typeof result.assistantMessageId === 'string' && result.assistantMessageId.trim()) ||
        (runId ? assistantMessageIdForRun(runId) : '')
      return acceptedRun(sessionId, runId, assistantMessageId)
    } catch (error) {
      const errorCode = readErrorCode(error)
      if (errorCode === 'session_evicted' && retryOnEvict) {
        console.warn('[agent-session-service] session_evicted; reopening from transcript', {
          sessionId
        })
        this.openPrefix.delete(sessionId)
        const reopened = await this.openWithTemplate(assembled)
        if (!reopened) return rejectedRun(sessionId, 'session_evicted', requestedRunId ?? '')
        return await this.sendTurnMessages(sessionId, assembled, false, requestedRunId)
      }
      console.warn('[agent-session-service] session-send failed', {
        sessionId,
        runId: requestedRunId,
        error: error instanceof Error ? error.message : String(error)
      })
      return rejectedRun(sessionId, errorCode ?? 'unknown', requestedRunId ?? '')
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function splitAssembledTurnMessages(messages: unknown[]): {
  history: Record<string, unknown>[]
  turn: Record<string, unknown>[]
} {
  const list = messages.filter(isRecord)
  let end = list.length
  while (end > 0 && isEmptyAssistant(list[end - 1]!)) end -= 1
  let start = end
  while (start > 0 && isUserContentTurn(list[start - 1]!)) start -= 1
  if (start >= end) {
    return { history: list.slice(0, end), turn: [] }
  }
  return { history: list.slice(0, start), turn: list.slice(start, end) }
}

function isEmptyAssistant(message: Record<string, unknown>): boolean {
  if (message.role !== 'assistant') return false
  const content = message.content
  if (typeof content === 'string') return content.trim().length === 0
  if (Array.isArray(content)) return content.length === 0
  return true
}

function isUserContentTurn(message: Record<string, unknown>): boolean {
  if (message.role !== 'user') return false
  const content = message.content
  if (!Array.isArray(content)) return true
  return content.some((block) => {
    if (!isRecord(block)) return true
    return block.type !== 'tool_result'
  })
}

function prefixIdentityFromAssembledParams(
  params: Record<string, unknown>,
  compaction: CompactWatermark | null
): string {
  const provider = isRecord(params.provider) ? params.provider : {}
  const snapshot = isRecord(params.capabilitySnapshot) ? params.capabilitySnapshot : {}
  const mode =
    readTrimmed(params.sessionPromptMode) ||
    readTrimmed(snapshot.mode) ||
    readTrimmed(params.sessionMode) ||
    ''
  return hostedSessionPrefixIdentity({
    sessionId: readTrimmed(params.sessionId),
    mode,
    providerId: readTrimmed(provider.providerId),
    modelId: readTrimmed(provider.model),
    workingFolder: typeof params.workingFolder === 'string' ? params.workingFolder : null,
    sshConnectionId: typeof params.sshConnectionId === 'string' ? params.sshConnectionId : null,
    compactFence: compactWatermarkFence(compaction)
  })
}

function readTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function toAssembleIntent(params: StartRunParams): AssembleSessionIntent {
  return {
    sessionId: params.sessionId,
    triggerMessageId: params.triggerMessageId,
    mode: params.mode,
    providerId: params.providerId,
    modelId: params.modelId,
    attachmentIds: params.attachmentIds,
    commandMetadata: params.commandMetadata
  }
}

function omitPinnedCommandFields(
  template: Record<string, unknown>
): Record<string, unknown> {
  const { slashCommand: _slashCommand, systemCommand: _systemCommand, ...rest } = template
  return rest
}

function copySessionSendTurnFields(
  template: Record<string, unknown>,
  payload: Record<string, unknown>
): void {
  for (const key of SESSION_SEND_TURN_KEYS) {
    if (template[key] !== undefined) payload[key] = template[key]
  }
}

function readTemplateToolNames(template: Record<string, unknown>): string[] {
  const tools = template.tools
  if (!Array.isArray(tools)) return []
  return tools
    .map((tool) =>
      tool && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string'
        ? tool.name
        : ''
    )
    .filter(Boolean)
}

function readErrorCodeFromResult(result: Record<string, unknown>): RuntimeErrorCode | null {
  const code = result.errorCode
  if (code === 'session_evicted') return 'session_evicted'
  if (typeof code === 'string') return 'unknown'
  return null
}

export type { RunContextAssemblerDeps, AssembleSessionIntent }
