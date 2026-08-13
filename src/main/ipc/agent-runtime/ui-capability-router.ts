import {
  SIDECAR_APPROVAL_REQUEST_MSGPACK_CHANNEL,
  SIDECAR_RENDERER_TOOL_REQUEST_MSGPACK_CHANNEL
} from '../../../shared/messagepack/binary-ipc'
import type { RuntimeApprovalSnapshot } from '../runtime-registry'
import { normalizeRendererRequestRecord, readNonEmptyString } from './request-utils'

export const UI_CAPABILITY_REQUEST_TIMEOUT_MS = 10 * 60_000

export const UI_CAPABILITY_METHODS = [
  'ask-user/request',
  'plan/ui-update',
  'team/ui-update',
  'subagent/ui-update',
  'browser/tool-request',
  'canvas/tool-request'
] as const

export type UiCapabilityMethod = (typeof UI_CAPABILITY_METHODS)[number]

export function isUiCapabilityMethod(method: string): method is UiCapabilityMethod {
  return (UI_CAPABILITY_METHODS as readonly string[]).includes(method)
}

export type ReverseTargetWindow = {
  id: number
}

export type ApprovalDecision = {
  approved: boolean
  reason?: string
}

type PendingApproval = {
  resolve: (value: ApprovalDecision) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  sessionId: string | null
  runId: string | null
  params: unknown
}

type PendingUiRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type UiCapabilityRouterDeps<TWindow extends ReverseTargetWindow> = {
  resolveWindow: (params: unknown) => TWindow | null
  sendReverseRequest: (window: TWindow, channel: string, payload: unknown) => boolean
  timeoutMs?: number
  now?: () => number
  randomId?: () => string
}

export class UiCapabilityRouter<TWindow extends ReverseTargetWindow = ReverseTargetWindow> {
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly pendingUiRequests = new Map<string, PendingUiRequest>()
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly deps: UiCapabilityRouterDeps<TWindow>

  constructor(deps: UiCapabilityRouterDeps<TWindow>) {
    this.deps = deps
    this.timeoutMs = deps.timeoutMs ?? UI_CAPABILITY_REQUEST_TIMEOUT_MS
    this.now = deps.now ?? Date.now
    this.randomId = deps.randomId ?? (() => Math.random().toString(36).slice(2, 10))
  }

  getApprovalSnapshots(): RuntimeApprovalSnapshot[] {
    const snapshots: RuntimeApprovalSnapshot[] = []
    for (const [requestId, pending] of this.pendingApprovals) {
      snapshots.push({
        requestId,
        sessionId: pending.sessionId,
        runId: pending.runId,
        params: pending.params
      })
    }
    return snapshots
  }

  async requestApproval(params: unknown): Promise<ApprovalDecision> {
    const targetWindow = this.deps.resolveWindow(params)
    if (!targetWindow) {
      return { approved: false, reason: 'No renderer available for approval request' }
    }

    const requestId = `sidecar-approval-${this.now()}-${this.randomId()}`
    const record = normalizeRendererRequestRecord(params)
    const sessionId = readNonEmptyString(record.sessionId) ?? null
    const runId = readNonEmptyString(record.runId) ?? readNonEmptyString(record.agentRunId) ?? null

    return await new Promise<ApprovalDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(requestId)
        reject(new Error('Renderer approval request timed out'))
      }, this.timeoutMs)

      this.pendingApprovals.set(requestId, {
        resolve,
        reject,
        timer,
        sessionId,
        runId,
        params
      })

      const sent = this.deps.sendReverseRequest(
        targetWindow,
        SIDECAR_APPROVAL_REQUEST_MSGPACK_CHANNEL,
        { requestId, method: 'approval/request', params }
      )

      if (!sent) {
        clearTimeout(timer)
        this.pendingApprovals.delete(requestId)
        resolve({ approved: false, reason: 'Failed to deliver approval request to renderer' })
      }
    })
  }

  async requestUiCapability(method: UiCapabilityMethod, params: unknown): Promise<unknown> {
    const requestId = `sidecar-${method.replace(/[^a-z0-9]+/gi, '-')}-${this.now()}-${this.randomId()}`
    const targetWindow = this.deps.resolveWindow(params)
    const requestLabel = uiCapabilityLabel(method)

    if (!targetWindow) {
      throw new Error(`No renderer available for ${requestLabel}`)
    }

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUiRequests.delete(requestId)
        reject(new Error(`${requestLabel} timed out`))
      }, this.timeoutMs)

      this.pendingUiRequests.set(requestId, { resolve, reject, timer })

      const sent = this.deps.sendReverseRequest(
        targetWindow,
        SIDECAR_RENDERER_TOOL_REQUEST_MSGPACK_CHANNEL,
        { requestId, method, params }
      )

      if (!sent) {
        clearTimeout(timer)
        this.pendingUiRequests.delete(requestId)
        reject(new Error(`Failed to deliver ${requestLabel} to renderer`))
      }
    })
  }

  completeApproval(payload: { requestId: string; approved: boolean; reason?: string }): {
    ok: boolean
  } {
    const pending = this.pendingApprovals.get(payload.requestId)
    if (!pending) return { ok: false }

    this.pendingApprovals.delete(payload.requestId)
    clearTimeout(pending.timer)
    pending.resolve({
      approved: payload.approved === true,
      ...(payload.reason ? { reason: payload.reason } : {})
    })
    return { ok: true }
  }

  completeUiCapability(payload: { requestId: string; result?: unknown; error?: string }): {
    ok: boolean
  } {
    const pending = this.pendingUiRequests.get(payload.requestId)
    if (!pending) return { ok: false }

    this.pendingUiRequests.delete(payload.requestId)
    clearTimeout(pending.timer)
    if (payload.error) {
      pending.reject(new Error(payload.error))
    } else {
      pending.resolve(payload.result)
    }
    return { ok: true }
  }

  repostApprovals(window: TWindow, runId: string, sessionId?: string): number {
    let repostedApprovals = 0
    for (const [requestId, pending] of this.pendingApprovals) {
      const matchesRun = pending.runId && pending.runId === runId
      const matchesSession = sessionId && pending.sessionId === sessionId
      if (!matchesRun && !matchesSession) continue
      const sent = this.deps.sendReverseRequest(window, SIDECAR_APPROVAL_REQUEST_MSGPACK_CHANNEL, {
        requestId,
        method: 'approval/request',
        params: pending.params
      })
      if (sent) repostedApprovals += 1
    }
    return repostedApprovals
  }
}

function uiCapabilityLabel(method: UiCapabilityMethod): string {
  switch (method) {
    case 'ask-user/request':
      return 'AskUserQuestion request'
    case 'browser/tool-request':
      return 'Browser tool request'
    case 'canvas/tool-request':
      return 'Canvas tool request'
    case 'team/ui-update':
      return 'Team UI update request'
    case 'subagent/ui-update':
      return 'Sub-agent UI update request'
    case 'plan/ui-update':
      return 'Plan UI update request'
  }
}
