import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  decodeAppendRunMessagesParams,
  decodeAttachRuntimeParams,
  decodeCancelRunParams,
  decodeCloseAgentSessionParams,
  decodeCompleteUiCapabilityParams,
  decodeGetDiagnosticsParams,
  decodeGetRuntimeSnapshotParams,
  decodeGetSessionRuntimeSnapshotParams,
  decodeGetToolCatalogParams,
  decodeInitializeRuntimeParams,
  decodeOpenAgentSessionParams,
  decodeRequestStopRunParams,
  decodeResolveApprovalParams,
  decodeSendSessionTurnParams,
  decodeStartRunParams,
  RUNTIME_MODEL_SCHEMA_VERSION,
  type AppendRunMessagesResult,
  type CancelRunResult,
  type RequestStopRunResult,
  type ResolveApprovalResult,
  type StartRunResult
} from '../../../shared/runtime-contracts/generated/contracts'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../../shared/messagepack/binary-ipc'
import { getRuntimeProjectionHost } from './runtime-projection'
import { getRuntimeDiagnosticsDetails } from './runtime-diagnostics'
import { getAgentSessionService, getHostedSessionToolCatalog } from './agent-session-service-host'
import { trackAcceptedHostedRun, type TrackedRun } from './runtime-command-gateway'
import type { RunTargetRouter } from './run-target-router'

export type RuntimeIpcDependencies = {
  isRunning: () => boolean
  ensureStarted: () => Promise<boolean>
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  resolveApproval: (payload: { requestId: string; approved: boolean; reason?: string }) => {
    ok: boolean
  }
  getWorkerInstanceId: () => string
  windows: RunTargetRouter
  activeRuns: Map<string, TrackedRun>
}

function registerRuntimeHandler<P, R>(
  channel: string,
  decodeParams: (value: unknown) => P,
  handler: (event: IpcMainInvokeEvent, params: P) => Promise<R> | R
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (event, bytes: Uint8Array) => {
    const params = decodeParams(decodeMessagePackPayload(bytes))
    return encodeMessagePackPayload(await handler(event, params))
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function rejectedHostedRun(sessionId: string): StartRunResult {
  return {
    accepted: false,
    runId: '',
    sessionId,
    assistantMessageId: '',
    errorCode: 'unknown',
    errorDetail: 'native worker failed to start'
  }
}

async function acceptHostedSessionRun(
  deps: RuntimeIpcDependencies,
  event: IpcMainInvokeEvent,
  params: { sessionId: string },
  start: () => Promise<StartRunResult>
): Promise<StartRunResult> {
  const ready = await deps.ensureStarted()
  if (!ready) return rejectedHostedRun(params.sessionId)
  deps.windows.rememberOrigin(event, params)
  const result = await start()
  if (result.accepted && result.runId) {
    deps.windows.rememberOrigin(event, params, result.runId)
    trackAcceptedHostedRun(deps.activeRuns, result.runId, result.sessionId || params.sessionId)
  }
  return result
}

export function registerRuntimeIpcHandlers(deps: RuntimeIpcDependencies): void {
  const host = getRuntimeProjectionHost()

  registerRuntimeHandler('runtime:initialize', decodeInitializeRuntimeParams, (event, params) => {
    host.bindSubscriber(params.subscriberId, event.sender.id, null)
    event.sender.once('destroyed', () => host.unbindSubscriber(params.subscriberId))
    return {
      ok: true,
      gatewayEpoch: host.gatewayEpoch,
      workerInstanceId: deps.getWorkerInstanceId() || host.workerInstanceId,
      schemaVersion: RUNTIME_MODEL_SCHEMA_VERSION,
      rolloutMode: 'shadow' as const
    }
  })

  registerRuntimeHandler('runtime:attach', decodeAttachRuntimeParams, (event, params) => {
    host.bindSubscriber(params.subscriberId, event.sender.id, params.sessionId)
    return host.attach(params)
  })

  registerRuntimeHandler('runtime:snapshot', decodeGetRuntimeSnapshotParams, (_event, _params) => ({
    snapshot: host.snapshot
  }))

  registerRuntimeHandler(
    'runtime:session-snapshot',
    decodeGetSessionRuntimeSnapshotParams,
    (_event, params) => ({
      snapshot: host.sessionSnapshot(params.sessionId)
    })
  )

  registerRuntimeHandler(
    'runtime:tool-catalog',
    decodeGetToolCatalogParams,
    async (_event, params) => ({
      tools: await getHostedSessionToolCatalog(params)
    })
  )

  registerRuntimeHandler('runtime:diagnostics', decodeGetDiagnosticsParams, () => ({
    ok: true,
    details: getRuntimeDiagnosticsDetails()
  }))

  registerRuntimeHandler(
    'runtime:open-session',
    decodeOpenAgentSessionParams,
    async (_event, params) => getAgentSessionService().openSession(params)
  )

  registerRuntimeHandler('runtime:start-run', decodeStartRunParams, async (event, params) =>
    acceptHostedSessionRun(deps, event, params, () => getAgentSessionService().startRun(params))
  )

  registerRuntimeHandler('runtime:send-turn', decodeSendSessionTurnParams, async (event, params) =>
    acceptHostedSessionRun(deps, event, params, () => getAgentSessionService().sendTurn(params))
  )

  registerRuntimeHandler(
    'runtime:close-session',
    decodeCloseAgentSessionParams,
    async (_event, params) => getAgentSessionService().closeSession(params.sessionId)
  )

  registerRuntimeHandler(
    'runtime:complete-ui-capability',
    decodeCompleteUiCapabilityParams,
    (_event, params) => ({
      ok: false,
      requestId: params.requestId
    })
  )

  registerRuntimeHandler(
    'runtime:cancel-run',
    decodeCancelRunParams,
    async (_event, params): Promise<CancelRunResult> => {
      if (!deps.isRunning()) return { cancelled: false, runId: params.runId }
      const result = asRecord(await deps.request('agent/cancel', { runId: params.runId }, 10_000))
      return {
        cancelled: result.cancelled === true,
        runId: typeof result.runId === 'string' ? result.runId : params.runId
      }
    }
  )

  registerRuntimeHandler(
    'runtime:request-stop',
    decodeRequestStopRunParams,
    async (_event, params): Promise<RequestStopRunResult> => {
      if (!deps.isRunning()) return { stopped: false, runId: params.runId }
      const result = asRecord(
        await deps.request('agent/request-stop', { runId: params.runId }, 10_000)
      )
      return {
        stopped: result.stopped === true,
        runId: typeof result.runId === 'string' ? result.runId : params.runId
      }
    }
  )

  registerRuntimeHandler(
    'runtime:append-messages',
    decodeAppendRunMessagesParams,
    async (_event, params): Promise<AppendRunMessagesResult> => {
      if (!deps.isRunning()) return { appended: false, runId: params.runId, count: 0 }
      const result = asRecord(
        await deps.request(
          'agent/append-messages',
          { runId: params.runId, messages: params.messages },
          10_000
        )
      )
      return {
        appended: result.appended === true,
        runId: typeof result.runId === 'string' ? result.runId : params.runId,
        count: typeof result.count === 'number' ? result.count : 0
      }
    }
  )

  registerRuntimeHandler(
    'runtime:resolve-approval',
    decodeResolveApprovalParams,
    (_event, params): ResolveApprovalResult => {
      const resolved = deps.resolveApproval({
        requestId: params.requestId,
        approved: params.decision === 'approved'
      })
      return { ok: resolved.ok, requestId: params.requestId }
    }
  )
}
