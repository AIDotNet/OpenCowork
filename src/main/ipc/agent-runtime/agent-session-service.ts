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
  RunContextAssemblerDeps
} from './run-context-assembler'
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

const SESSION_SEND_TURN_KEYS = [
  'requestContextTexts',
  'planMode',
  'planRevision',
  'planExecution',
  'planModeAllowedTools',
  'commandMetadata',
  'attachmentIds'
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
            ...assembled.openTemplate,
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
          ...assembled.openTemplate,
          messages: assembled.historyMessages
        },
        30_000
      )
    )
    const sessionId =
      typeof result.sessionId === 'string' ? result.sessionId : String(assembled.openTemplate.sessionId ?? '')
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
    retryOnEvict: boolean
  ): Promise<StartRunResult> {
    const requestedRunId = this.deps.nextRunId?.().trim() || undefined
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
        return await this.sendTurnMessages(sessionId, assembled, false)
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
