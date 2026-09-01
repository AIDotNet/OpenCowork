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
import { hostedSessionPrefixIdentity, hostedSessionProviderFence } from './run-context-assembler'
import {
  applyCompactWatermark,
  compactWatermarkFence,
  deriveCompactWatermarkFromTranscript,
  type CompactWatermark,
  type WatermarkMessage
} from '../../../shared/compact-watermark'
import {
  isCompactSummaryLikeMessage,
  type CompactRequestMessage
} from '../../../shared/compact-request-view'
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

type RunErrorInfo = {
  code: RuntimeErrorCode | null
  /** Raw cause (worker errorCode + message) preserved for the UI. */
  detail: string | null
}

function mapKnownErrorCode(code: string): RuntimeErrorCode {
  if (code === 'session_evicted') return 'session_evicted'
  if (code === 'worker_interrupted') return 'worker_interrupted'
  if (code === 'protocol_mismatch') return 'protocol_mismatch'
  if (code === 'runtime_expired') return 'runtime_expired'
  return 'unknown'
}

function readErrorInfo(error: unknown): RunErrorInfo {
  const message = error instanceof Error ? error.message : String(error)
  const rawCode =
    error && typeof error === 'object' && 'errorCode' in error
      ? (error as { errorCode?: unknown }).errorCode
      : undefined
  if (typeof rawCode === 'string' && rawCode.trim()) {
    const code = rawCode.trim()
    const detail = message.startsWith(code) ? message : `${code}: ${message}`
    return { code: mapKnownErrorCode(code), detail }
  }
  if (message.includes('session_evicted')) {
    return { code: 'session_evicted', detail: message }
  }
  return { code: null, detail: message }
}

function readErrorInfoFromResult(result: Record<string, unknown>): RunErrorInfo {
  const rawCode = typeof result.errorCode === 'string' ? result.errorCode.trim() : ''
  const rawMessage = typeof result.error === 'string' ? result.error.trim() : ''
  const detail = [rawCode, rawMessage].filter(Boolean).join(': ') || null
  return { code: rawCode ? mapKnownErrorCode(rawCode) : null, detail }
}

function rejectedRun(
  sessionId: string,
  errorCode: RuntimeErrorCode | null,
  runId = '',
  errorDetail: string | null = null
): StartRunResult {
  return {
    accepted: false,
    runId,
    sessionId,
    assistantMessageId: '',
    errorCode,
    errorDetail
  }
}

function acceptedRun(sessionId: string, runId: string, assistantMessageId: string): StartRunResult {
  return {
    accepted: true,
    runId,
    sessionId,
    assistantMessageId,
    errorCode: null,
    errorDetail: null
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
      if (isOpenSessionOk(result)) {
        this.openPrefix.set(sessionId, {
          identity: assembled.prefixIdentity,
          toolNames: readTemplateToolNames(assembled.openTemplate)
        })
      }
      return {
        ok: isOpenSessionOk(result),
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
    const list = messages.filter(isRecord)

    // A session compacted by an older build has no record; its cut is derived
    // from the marker rows the caller still carries so the enforcement below
    // covers legacy sessions too. Apply the cut to the full payload before
    // splitting the turn: the summary is itself a user message, so splitting
    // first can park it in `turn` and then cut `history` without it.
    const compaction =
      (await this.deps.readCompaction?.(sessionId)) ??
      deriveCompactWatermarkFromTranscript(list as WatermarkMessage[])
    const visible = applyCompactWatermark(list as WatermarkMessage[], compaction)
    if (visible.length !== list.length) {
      console.log('[agent-session-service] Re-applied compaction cut to assembled run', {
        sessionId,
        before: list.length,
        after: visible.length,
        throughSortOrder: compaction?.throughSortOrder ?? null
      })
    }

    const { history, turn } = splitAssembledTurnMessages(visible)
    if (turn.length === 0) return null

    const { messages: _messages, runId: _runId, ...template } = params
    const assembled: AssembledSessionContext = {
      openTemplate: { ...template, messages: history },
      historyMessages: history as AssembledWireMessage[],
      turnMessages: turn as AssembledWireMessage[],
      prefixIdentity: prefixIdentityFromAssembledParams(params, compaction)
    }

    if (!this.canReuseOpenSession(sessionId, assembled.prefixIdentity)) {
      const opened = await this.openWithTemplate(assembled)
      if (!opened) {
        return (
          (await this.runLegacyFallback(assembled, sessionId, options?.runId, 'session-open')) ??
          rejectedRun(sessionId, 'unknown', options?.runId ?? '', 'agent/session-open failed')
        )
      }
    }
    const sent = await this.sendTurnMessages(sessionId, assembled, true, options?.runId)
    if (sent.accepted) return sent
    return (
      (await this.runLegacyFallback(assembled, sessionId, options?.runId, 'session-send')) ?? sent
    )
  }

  async startRun(params: StartRunParams): Promise<StartRunResult> {
    if (!this.deps.isRunning()) {
      return rejectedRun(params.sessionId, 'unknown', '', 'native worker is not running')
    }
    let assembled: AssembledSessionContext
    try {
      assembled = await this.deps.assemble(toAssembleIntent(params))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn('[agent-session-service] assemble failed', {
        sessionId: params.sessionId,
        error: detail
      })
      return rejectedRun(params.sessionId, 'unknown', '', `run assembly failed: ${detail}`)
    }
    if (assembled.turnMessages.length === 0) {
      return rejectedRun(params.sessionId, 'unknown', '', 'assembled run has no turn messages')
    }

    return await this.openAndSendWithFallback(params.sessionId, assembled)
  }

  async sendTurn(params: SendSessionTurnParams): Promise<SendSessionTurnResult> {
    if (!this.deps.isRunning()) {
      return rejectedRun(params.sessionId, 'unknown', '', 'native worker is not running')
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
      const detail = error instanceof Error ? error.message : String(error)
      console.warn('[agent-session-service] assemble failed', {
        sessionId: params.sessionId,
        error: detail
      })
      return rejectedRun(params.sessionId, 'unknown', '', `run assembly failed: ${detail}`)
    }
    if (assembled.turnMessages.length === 0) {
      return rejectedRun(params.sessionId, 'unknown', '', 'assembled turn has no turn messages')
    }
    return await this.openAndSendWithFallback(params.sessionId, assembled)
  }

  /**
   * Shared hosted-run pipeline: open (when the pinned prefix changed) + send,
   * falling back to a one-shot legacy `agent/run` when the hosted path cannot
   * accept the turn. The fallback reuses the same runId, so the durable job
   * store dedupes against a session-send that may in fact have committed.
   */
  private async openAndSendWithFallback(
    sessionId: string,
    assembled: AssembledSessionContext
  ): Promise<StartRunResult> {
    const runId = this.deps.nextRunId?.().trim() || undefined
    if (!this.canReuseOpenSession(sessionId, assembled.prefixIdentity)) {
      const opened = await this.openWithTemplate(assembled)
      if (!opened) {
        return (
          (await this.runLegacyFallback(assembled, sessionId, runId, 'session-open')) ??
          rejectedRun(sessionId, 'unknown', runId ?? '', 'agent/session-open failed')
        )
      }
    }
    const sent = await this.sendTurnMessages(sessionId, assembled, true, runId)
    if (sent.accepted) return sent
    return (await this.runLegacyFallback(assembled, sessionId, runId, 'session-send')) ?? sent
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
    if (isOpenSessionOk(result) && sessionId) {
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
    // The submit is idempotent on runId (a duplicate returns accepted+duplicate),
    // so one transparent retry is safe even when the first attempt timed out
    // after the worker actually committed the job.
    let transientRetryUsed = false
    for (;;) {
      try {
        const result = asRecord(await this.deps.request('agent/session-send', payload, 60_000))
        const accepted = result.started === true || result.accepted === true
        const runId =
          (typeof result.runId === 'string' && result.runId.trim()) || requestedRunId || ''
        if (!accepted) {
          const info = readErrorInfoFromResult(result)
          return rejectedRun(sessionId, info.code ?? 'unknown', runId, info.detail)
        }
        const assistantMessageId =
          (typeof result.assistantMessageId === 'string' && result.assistantMessageId.trim()) ||
          (runId ? assistantMessageIdForRun(runId) : '')
        return acceptedRun(sessionId, runId, assistantMessageId)
      } catch (error) {
        const info = readErrorInfo(error)
        if (info.code === 'session_evicted' && retryOnEvict) {
          console.warn('[agent-session-service] session_evicted; reopening from transcript', {
            sessionId
          })
          this.openPrefix.delete(sessionId)
          const reopened = await this.openWithTemplate(assembled)
          if (!reopened) {
            return rejectedRun(sessionId, 'session_evicted', requestedRunId ?? '', info.detail)
          }
          retryOnEvict = false
          continue
        }
        if (info.code !== 'session_evicted' && requestedRunId && !transientRetryUsed) {
          transientRetryUsed = true
          console.warn('[agent-session-service] session-send failed; retrying once', {
            sessionId,
            runId: requestedRunId,
            error: info.detail
          })
          continue
        }
        console.warn('[agent-session-service] session-send failed', {
          sessionId,
          runId: requestedRunId,
          error: info.detail
        })
        return rejectedRun(sessionId, info.code ?? 'unknown', requestedRunId ?? '', info.detail)
      }
    }
  }

  /**
   * Last-resort path when hosted open/send cannot accept a turn: submit the
   * fully assembled conversation as a one-shot legacy `agent/run`, which needs
   * no open worker session. Compaction was already applied to
   * `historyMessages`, so the fallback cannot resurrect summarized turns, and
   * reusing the runId keeps the durable job store idempotent against a
   * session-send that may in fact have committed.
   */
  private async runLegacyFallback(
    assembled: AssembledSessionContext,
    sessionId: string,
    runId: string | undefined,
    cause: string
  ): Promise<StartRunResult | null> {
    if (!this.deps.isRunning()) return null
    const effectiveRunId = runId?.trim() || this.deps.nextRunId?.().trim() || undefined
    const payload: Record<string, unknown> = {
      ...assembled.openTemplate,
      sessionId,
      messages: [...assembled.historyMessages, ...assembled.turnMessages]
    }
    if (effectiveRunId) payload.runId = effectiveRunId
    try {
      const result = asRecord(await this.deps.request('agent/run', payload, 60_000))
      const accepted = result.started === true || result.accepted === true
      const acceptedRunId =
        (typeof result.runId === 'string' && result.runId.trim()) || effectiveRunId || ''
      if (!accepted || !acceptedRunId) return null
      console.warn('[agent-session-service] hosted run fell back to legacy agent/run', {
        sessionId,
        runId: acceptedRunId,
        cause
      })
      const assistantMessageId =
        (typeof result.assistantMessageId === 'string' && result.assistantMessageId.trim()) ||
        assistantMessageIdForRun(acceptedRunId)
      return acceptedRun(sessionId, acceptedRunId, assistantMessageId)
    } catch (error) {
      console.warn('[agent-session-service] legacy agent/run fallback failed', {
        sessionId,
        runId: effectiveRunId,
        cause,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Contract field is `ok`; older Node payloads used `opened`. Either means the session is live. */
function isOpenSessionOk(result: Record<string, unknown>): boolean {
  return result.ok === true || result.opened === true
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
  if (isCompactSummaryLikeMessage(asCompactRequestMessage(message))) return false
  const content = message.content
  if (!Array.isArray(content)) return true
  return content.some((block) => {
    if (!isRecord(block)) return true
    return block.type !== 'tool_result'
  })
}

function asCompactRequestMessage(message: Record<string, unknown>): CompactRequestMessage {
  return {
    id: typeof message.id === 'string' ? message.id : '',
    role: typeof message.role === 'string' ? message.role : '',
    content: message.content,
    createdAt: typeof message.createdAt === 'number' ? message.createdAt : 0,
    meta: isRecord(message.meta) ? message.meta : undefined
  }
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
    providerType: readTrimmed(provider.type),
    providerFence: hostedSessionProviderFence(provider),
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

function omitPinnedCommandFields(template: Record<string, unknown>): Record<string, unknown> {
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

export type { RunContextAssemblerDeps, AssembleSessionIntent }
