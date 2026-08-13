import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../../shared/messagepack/binary-ipc'
import { readPermissionPolicySnapshot } from '../settings-handlers'
import { getNativeSshConnectionPayload } from '../ssh-connection-payload'
import { getGoalRuntimeService } from '../../goals/goal-runtime'
import { runHooks } from '../../hooks/hooks-service'
import { getSession } from '../../db/sessions-dao'
import {
  collectHookContextTexts,
  HOOK_COMPACT_TRIGGER,
  HOOK_EVENTS,
  HOOK_RUN_SOURCE,
  HOOK_SESSION_START_SOURCE,
  type HookRunSource
} from '../../../shared/hooks/types'
import { getRuntimeRegistry } from '../runtime-registry'
import {
  asOptionalRecord,
  normalizeRendererRequestRecord,
  readNonEmptyString,
  readStringArray
} from './request-utils'
import { isUsableRendererWindow, type RunTargetRouter } from './run-target-router'
import type { UiCapabilityRouter } from './ui-capability-router'

export type TrackedRun = {
  sessionId: string
  lastSeq: number
  dispatchedAt: number
  acceptedAt: number | null
  lastEventAt: number | null
  jobState: 'queued' | 'running'
}

export type RuntimeCommandGatewayDeps = {
  isRunning: () => boolean
  ensureStarted: () => Promise<boolean>
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  notify: (method: string, params?: unknown) => void
  setSessionVisibility: (sessionId: string, visible: boolean) => void
  windows: RunTargetRouter
  uiCapabilities: UiCapabilityRouter<BrowserWindow>
  activeRuns: Map<string, TrackedRun>
  recoverPump: (runId?: string) => Promise<{ published: number; jobState: string | null }>
  flushStreamBatches: () => void
  sendAgentStreamBytes: (
    targetWindow: BrowserWindow,
    bytes: Uint8Array | Buffer,
    details: Record<string, unknown>
  ) => boolean
}

function registerMessagePackInvokeHandler<TArgs>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(event, args))
  })
}

function getProviderRecord(params: Record<string, unknown>): Record<string, unknown> {
  return normalizeRendererRequestRecord(params.provider)
}

function readAgentRunSource(value: unknown): 'user_turn' | 'continue' {
  return value === 'continue' ? 'continue' : 'user_turn'
}

function resolveSessionStartRunSource(record: Record<string, unknown>): HookRunSource {
  if (readNonEmptyString(record.goalRunSource) === HOOK_RUN_SOURCE.continue) {
    return HOOK_RUN_SOURCE.continue
  }
  if (record.translation) return HOOK_RUN_SOURCE.translation
  if (readNonEmptyString(record.pluginId)) return HOOK_RUN_SOURCE.pluginAutoReply
  if (readNonEmptyString(record.cronJobId)) return HOOK_RUN_SOURCE.cron
  return HOOK_RUN_SOURCE.chat
}

function enrichAgentRunParams(params: unknown): unknown {
  const record = normalizeRendererRequestRecord(params)
  const sshConnectionId = readNonEmptyString(record.sshConnectionId)
  if (!sshConnectionId || record.connection) return params

  const connection = getNativeSshConnectionPayload(sshConnectionId)
  if (!connection) {
    console.warn(`[Sidecar] SSH connection not found for native agent run: ${sshConnectionId}`)
    return params
  }

  return {
    ...record,
    connection
  }
}

async function prepareGoalAwareAgentRunParams(
  params: unknown,
  request: RuntimeCommandGatewayDeps['request']
): Promise<unknown> {
  const enrichedParams = enrichAgentRunParams(params)
  const record = normalizeRendererRequestRecord(enrichedParams)
  const runId = readNonEmptyString(record.runId)
  const sessionId = readNonEmptyString(record.sessionId)
  const messages = Array.isArray(record.messages) ? record.messages : null

  if (!runId || !sessionId || !messages) {
    return enrichedParams
  }

  const preparedMessages = await getGoalRuntimeService().prepareRun({
    runId,
    sessionId,
    planMode: record.planMode === true,
    source: readAgentRunSource(record.goalRunSource),
    messages: messages as Parameters<
      ReturnType<typeof getGoalRuntimeService>['prepareRun']
    >[0]['messages'],
    enqueueMessages: (queuedMessages) => {
      void request(
        'agent/append-messages',
        {
          runId,
          messages: queuedMessages
        },
        10_000
      ).catch((error) => {
        console.warn(
          '[Sidecar] Failed to append goal runtime messages:',
          error instanceof Error ? error.message : String(error)
        )
      })
    }
  })

  return {
    ...record,
    messages: preparedMessages
  }
}

async function runSessionStartHook(params: unknown): Promise<unknown> {
  const record = normalizeRendererRequestRecord(params)
  const provider = getProviderRecord(record)
  const tools = Array.isArray(record.tools) ? record.tools : []
  const toolNames = tools
    .map((tool) => normalizeRendererRequestRecord(tool).name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
  const sessionId = readNonEmptyString(record.sessionId)
  const runId = readNonEmptyString(record.runId)
  const workingFolder = readNonEmptyString(record.workingFolder)
  const sshConnectionId = readNonEmptyString(record.sshConnectionId)
  const goalRunSource = readNonEmptyString(record.goalRunSource)
  const hookResult = await runHooks({
    eventName: HOOK_EVENTS.sessionStart,
    matcherValue:
      goalRunSource === HOOK_RUN_SOURCE.continue
        ? HOOK_SESSION_START_SOURCE.resume
        : HOOK_SESSION_START_SOURCE.startup,
    sessionId,
    runId,
    projectRoot: workingFolder,
    sshConnectionId,
    input: {
      source:
        goalRunSource === HOOK_RUN_SOURCE.continue
          ? HOOK_SESSION_START_SOURCE.resume
          : HOOK_SESSION_START_SOURCE.startup,
      runSource: resolveSessionStartRunSource(record),
      sessionMode: readNonEmptyString(record.sessionMode),
      toolNames,
      providerType: readNonEmptyString(provider.type) ?? '',
      modelId: readNonEmptyString(provider.model)
    }
  })
  if (hookResult.blocked) {
    throw new Error(hookResult.reason || 'SessionStart hook blocked agent run')
  }
  const hookContextTexts = collectHookContextTexts(hookResult)
  if (hookContextTexts.length === 0) return params
  return {
    ...record,
    requestContextTexts: [...readStringArray(record.requestContextTexts), ...hookContextTexts]
  }
}

async function validateAgentRunCapabilityContext(params: unknown): Promise<void> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return
  const request = params as Record<string, unknown>
  if (request.runtimeProtocolVersion !== 2) return
  if (
    !request.capabilitySnapshot ||
    typeof request.capabilitySnapshot !== 'object' ||
    Array.isArray(request.capabilitySnapshot)
  ) {
    throw new Error('manifest_mismatch: Runtime v2 requires a capabilitySnapshot')
  }

  const snapshot = request.capabilitySnapshot as Record<string, unknown>
  const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
  const snapshotSessionId = typeof snapshot.sessionId === 'string' ? snapshot.sessionId.trim() : ''
  if (sessionId !== snapshotSessionId) {
    throw new Error('capability_context_mismatch: Snapshot sessionId does not match the run')
  }

  const requestProjectId = typeof request.projectId === 'string' ? request.projectId.trim() : ''
  const snapshotProjectId = typeof snapshot.projectId === 'string' ? snapshot.projectId.trim() : ''
  const canvasContext = asOptionalRecord(request.canvasContext) ?? null
  const canvasProjectId =
    typeof canvasContext?.projectId === 'string' ? canvasContext.projectId.trim() : ''

  if (sessionId.startsWith('graph-agent:')) {
    if (!canvasProjectId || sessionId !== `graph-agent:${canvasProjectId}`) {
      throw new Error(
        `capability_context_mismatch: Canvas session ${sessionId} is not bound to a canvas project`
      )
    }
    if (requestProjectId !== canvasProjectId || snapshotProjectId !== canvasProjectId) {
      throw new Error(
        `capability_context_mismatch: Canvas session ${sessionId} is not bound to the requested project`
      )
    }
    return
  }

  if (!sessionId) return
  const session = await getSession(sessionId)
  if (!session) {
    throw new Error(`capability_context_mismatch: Unknown session ${sessionId}`)
  }
  const expectedProjectId = session.project_id?.trim() ?? ''
  if (
    requestProjectId !== expectedProjectId ||
    snapshotProjectId !== expectedProjectId ||
    (canvasProjectId && canvasProjectId !== expectedProjectId)
  ) {
    throw new Error(
      `capability_context_mismatch: Session ${sessionId} is not bound to the requested project`
    )
  }
}

async function runManualCompactHooks(
  phase: typeof HOOK_EVENTS.preCompact | typeof HOOK_EVENTS.postCompact,
  params: unknown,
  result?: unknown
): Promise<void> {
  const record = normalizeRendererRequestRecord(params)
  const resultRecord = normalizeRendererRequestRecord(result)
  const compressionResult = normalizeRendererRequestRecord(resultRecord.result)
  const hookResult = await runHooks({
    eventName: phase,
    matcherValue: 'manual',
    sessionId: readNonEmptyString(record.sessionId),
    projectRoot: readNonEmptyString(record.workingFolder),
    sshConnectionId: readNonEmptyString(record.sshConnectionId),
    input: {
      trigger: HOOK_COMPACT_TRIGGER.manual,
      originalCount:
        typeof compressionResult.originalCount === 'number'
          ? compressionResult.originalCount
          : undefined,
      newCount:
        typeof compressionResult.newCount === 'number' ? compressionResult.newCount : undefined
    }
  })
  if (hookResult.blocked) {
    if (phase === HOOK_EVENTS.postCompact) {
      console.warn(
        `[Hooks] PostCompact hook requested block after compression: ${hookResult.reason || 'Blocked by hook'}`
      )
      return
    }
    throw new Error(hookResult.reason || `${phase} hook blocked context compression`)
  }
}

export function trackAcceptedHostedRun(
  activeRuns: Map<string, TrackedRun>,
  runId: string,
  sessionId: string
): void {
  if (!runId || !sessionId) return
  const existing = activeRuns.get(runId)
  const now = Date.now()
  activeRuns.set(runId, {
    sessionId,
    lastSeq: existing?.lastSeq ?? 0,
    dispatchedAt: existing?.dispatchedAt ?? now,
    acceptedAt: existing?.acceptedAt ?? now,
    lastEventAt: existing?.lastEventAt ?? null,
    jobState: existing?.jobState ?? 'running'
  })
}

function acceptTrackedRun(
  activeRuns: Map<string, TrackedRun>,
  requestedRunId: string | undefined,
  result: { runId: string; state?: string }
): void {
  if (requestedRunId && result.runId !== requestedRunId) {
    const pretracked = activeRuns.get(requestedRunId)
    const streamedRun = activeRuns.get(result.runId)
    activeRuns.delete(requestedRunId)
    const resultRun = getRuntimeRegistry()
      .getRunSnapshots()
      .find((run) => run.runId === result.runId)
    if (pretracked && streamedRun) {
      activeRuns.set(result.runId, {
        ...pretracked,
        ...streamedRun,
        dispatchedAt: pretracked.dispatchedAt,
        acceptedAt: streamedRun.acceptedAt ?? pretracked.acceptedAt ?? Date.now()
      })
    } else if (pretracked && !resultRun) {
      activeRuns.set(result.runId, {
        ...pretracked,
        acceptedAt: Date.now(),
        jobState: result.state === 'running' ? 'running' : 'queued'
      })
    }
    return
  }
  if (!requestedRunId) return
  const trackedRun = activeRuns.get(requestedRunId)
  if (!trackedRun) return
  activeRuns.set(requestedRunId, {
    ...trackedRun,
    acceptedAt: trackedRun.acceptedAt ?? Date.now(),
    jobState: result.state === 'running' ? 'running' : trackedRun.jobState
  })
}

export function registerRuntimeCommandGateway(deps: RuntimeCommandGatewayDeps): void {
  registerMessagePackInvokeHandler<unknown>('agent:run', async (event, params) => {
    console.log('[Sidecar] agent:run requested')
    deps.windows.rememberOrigin(event, params)
    const ready = await deps.ensureStarted()
    if (!ready) throw new Error('SIDECAR_UNAVAILABLE')
    const enrichedParams = await prepareGoalAwareAgentRunParams(params, deps.request)
    const hookAdjustedParams = await runSessionStartHook(enrichedParams)
    await validateAgentRunCapabilityContext(hookAdjustedParams)
    if (
      hookAdjustedParams &&
      typeof hookAdjustedParams === 'object' &&
      !Array.isArray(hookAdjustedParams) &&
      (hookAdjustedParams as Record<string, unknown>).permissionPolicy === undefined
    ) {
      const permissionPolicy = readPermissionPolicySnapshot()
      if (permissionPolicy) {
        ;(hookAdjustedParams as Record<string, unknown>).permissionPolicy = permissionPolicy
      }
    }
    const runRecord = normalizeRendererRequestRecord(hookAdjustedParams)
    let requestedRunId = readNonEmptyString(runRecord.runId)
    const requestedSessionId = readNonEmptyString(runRecord.sessionId)
    if (!requestedRunId && requestedSessionId) {
      requestedRunId = randomUUID()
      runRecord.runId = requestedRunId
    }
    if (requestedRunId && requestedSessionId) {
      deps.activeRuns.set(requestedRunId, {
        sessionId: requestedSessionId,
        lastSeq: 0,
        dispatchedAt: Date.now(),
        acceptedAt: null,
        lastEventAt: null,
        jobState: 'queued'
      })
    }
    try {
      const result = (await deps.request('agent/run', hookAdjustedParams, 60_000)) as {
        started: boolean
        runId: string
        state?: string
      }
      deps.windows.rememberOrigin(event, hookAdjustedParams, result.runId)
      acceptTrackedRun(deps.activeRuns, requestedRunId, result)
      console.log('[Sidecar] agent:run request accepted')
      return result
    } catch (error) {
      if (requestedRunId) deps.activeRuns.delete(requestedRunId)
      console.warn(
        `[Sidecar] agent:run failed: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }
  })

  registerMessagePackInvokeHandler<unknown>('agent:cancel', async (_event, params) => {
    if (!deps.isRunning()) {
      return { cancelled: false }
    }
    const result = (await deps.request('agent/cancel', params, 10_000)) as {
      cancelled: boolean
      runId?: string
    }
    if (result.cancelled && result.runId) {
      deps.windows.forgetPrimary(result.runId)
    }
    return result
  })

  let ignoredRendererEventAcks = 0
  registerMessagePackInvokeHandler<{ runId?: string; throughSeq?: number }>(
    'agent:event-ack',
    async (_event, params) => {
      ignoredRendererEventAcks += 1
      if (ignoredRendererEventAcks === 1 || ignoredRendererEventAcks % 100 === 0) {
        console.warn('[Sidecar] ignored renderer durable event-ack; Main is the sole writer', {
          count: ignoredRendererEventAcks,
          runId: readNonEmptyString(params?.runId),
          throughSeq: params?.throughSeq
        })
      }
      return { acked: false, ignored: true }
    }
  )

  registerMessagePackInvokeHandler<unknown>('agent:recover-stream', async (event, params) => {
    const record = normalizeRendererRequestRecord(params)
    const runId = readNonEmptyString(record.runId)
    const sessionId = readNonEmptyString(record.sessionId)
    const sourceWindow = BrowserWindow.fromWebContents(event.sender)

    if (runId && isUsableRendererWindow(sourceWindow)) {
      deps.windows.bindPrimary(runId, sessionId, sourceWindow.id)
      deps.windows.attachObserver(runId, sourceWindow.id)
    }

    const recovery = runId
      ? await deps.recoverPump(runId)
      : { published: 0, jobState: null as string | null }

    deps.flushStreamBatches()

    let journalFrames = 0
    if (runId && isUsableRendererWindow(sourceWindow)) {
      const frames = getRuntimeRegistry().getFramesSince(runId, -1)
      journalFrames = frames.length
      for (const bytes of frames) {
        deps.sendAgentStreamBytes(sourceWindow, bytes, {
          source: 'recover-stream-journal',
          runId,
          frames: frames.length
        })
      }
    }

    const tracked = runId ? deps.activeRuns.get(runId) : undefined
    return {
      recovered: true,
      runId: runId ?? null,
      published: recovery.published,
      jobState: recovery.jobState ?? tracked?.jobState ?? null,
      journalFrames,
      lastEventAt: tracked?.lastEventAt ?? null,
      acceptedAt: tracked?.acceptedAt ?? null
    }
  })

  registerMessagePackInvokeHandler<unknown>('agent:runtime-state', async (_event, _params) => {
    const registry = getRuntimeRegistry()
    return {
      runs: registry.getRunSnapshots(),
      approvals: registry.getApprovalSnapshots()
    }
  })

  registerMessagePackInvokeHandler<unknown>('agent:attach-run', async (event, params) => {
    const record = normalizeRendererRequestRecord(params)
    const runId = readNonEmptyString(record.runId)
    if (!runId) {
      return { attached: false, frames: 0 }
    }
    const sinceSeq = typeof record.sinceSeq === 'number' ? record.sinceSeq : -1

    const sourceWindow = BrowserWindow.fromWebContents(event.sender)
    if (!isUsableRendererWindow(sourceWindow)) {
      return { attached: false, frames: 0 }
    }

    deps.windows.attachObserver(runId, sourceWindow.id)
    deps.flushStreamBatches()

    const frames = getRuntimeRegistry().getFramesSince(runId, sinceSeq)
    for (const bytes of frames) {
      deps.sendAgentStreamBytes(sourceWindow, bytes, { source: 'journal-replay', runId })
    }

    const sessionId = readNonEmptyString(record.sessionId)
    const repostedApprovals = deps.uiCapabilities.repostApprovals(sourceWindow, runId, sessionId)

    return { attached: true, frames: frames.length, repostedApprovals }
  })

  registerMessagePackInvokeHandler<unknown>('agent:request-stop', async (_event, params) => {
    if (!deps.isRunning()) {
      return { stopped: false }
    }
    return await deps.request('agent/request-stop', params, 10_000)
  })

  registerMessagePackInvokeHandler<unknown>('agent:append-messages', async (_event, params) => {
    if (!deps.isRunning()) {
      return { appended: false, count: 0 }
    }
    return await deps.request('agent/append-messages', params, 10_000)
  })

  registerMessagePackInvokeHandler<unknown>('agent:compress-context', async (_event, params) => {
    const ready = await deps.ensureStarted()
    if (!ready) throw new Error('SIDECAR_UNAVAILABLE')
    await runManualCompactHooks(HOOK_EVENTS.preCompact, params)
    const result = await deps.request('agent/compress-context', params, 130_000)
    await runManualCompactHooks(HOOK_EVENTS.postCompact, params, result)
    return result
  })

  ipcMain.on(toMessagePackChannel('agent:session-visibility'), (event, bytes: Uint8Array) => {
    const payload = decodeMessagePackPayload<{ sessionId?: string; visible?: boolean }>(bytes)
    const sessionId = readNonEmptyString(payload?.sessionId)
    if (!sessionId) return

    const sourceWindow = BrowserWindow.fromWebContents(event.sender)
    if (isUsableRendererWindow(sourceWindow)) {
      deps.windows.setSessionWindow(sessionId, sourceWindow, payload.visible === true)
    }

    deps.setSessionVisibility(sessionId, payload.visible === true)
  })
}
