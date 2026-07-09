import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { app } from 'electron'
import type {
  HookEventName,
  HookOutput,
  HookRunDecision,
  HookRunRequest,
  HookRunResult,
  HookRunStatus
} from '../../shared/hooks/types'
import {
  HOOK_DECISION,
  HOOK_EVENTS,
  HOOK_PERMISSION_BEHAVIOR,
  HOOK_RUN_STATUS,
  HOOK_TRUST_STATUS
} from '../../shared/hooks/types'
import { insertHookRun } from './hooks-db'
import type { ResolvedHookDefinition } from './hooks-loader'
import { newId, normalizeError, readRecord, truncateText } from './hooks-utils'

const MAX_STDIN_BYTES = 256 * 1024
const MAX_STDOUT_PREVIEW_CHARS = 256 * 1024
const MAX_STDERR_PREVIEW_CHARS = 64 * 1024
const MAX_TOTAL_CONCURRENT_HOOKS = 4
const SKIP_AUDIT_EVENTS = new Set<HookEventName>([])
const MATCHER_IGNORED_EVENTS = new Set<HookEventName>([
  HOOK_EVENTS.userPromptSubmit,
  HOOK_EVENTS.stop
])

let activeHookProcesses = 0
const waitQueue: Array<() => void> = []
const canceledHookRunKeys = new Set<string>()
const activeHookProcessesByKey = new Map<string, Set<ChildProcess>>()

export function cancelHookRunsByKey(cancellationKey: string): void {
  if (!cancellationKey) return
  canceledHookRunKeys.add(cancellationKey)
  const processes = activeHookProcessesByKey.get(cancellationKey)
  for (const child of processes ?? []) {
    terminateHookProcess(child.pid)
  }
  setTimeout(() => {
    if (!activeHookProcessesByKey.has(cancellationKey)) {
      canceledHookRunKeys.delete(cancellationKey)
    }
  }, 5 * 60_000).unref()
}

export async function runMatchingHooks(args: {
  request: HookRunRequest
  hooks: ResolvedHookDefinition[]
}): Promise<HookRunResult> {
  const result: HookRunResult = {
    ok: true,
    systemMessages: [],
    additionalContext: []
  }
  const matchingHooks = args.hooks.filter((hook) => matchesHook(hook, args.request))

  for (const hook of matchingHooks) {
    if (isHookRunCanceled(args.request)) break
    if (hook.trustStatus !== HOOK_TRUST_STATUS.trusted) {
      if (!SKIP_AUDIT_EVENTS.has(args.request.eventName)) {
        await auditHookRun({
          hook,
          request: args.request,
          status: HOOK_RUN_STATUS.skipped,
          skippedReason: hook.trustStatus
        })
      }
      continue
    }

    const execution = await executeHookCommand(hook, args.request)
    mergeExecutionResult(result, execution.output, args.request.eventName)
    if (execution.blocked) {
      result.blocked = true
      result.reason = execution.reason || result.reason || 'Blocked by hook'
      break
    }
    if (result.permissionDecision?.behavior === HOOK_PERMISSION_BEHAVIOR.deny) break
  }

  return result
}

function matchesHook(hook: ResolvedHookDefinition, request: HookRunRequest): boolean {
  if (hook.eventName !== request.eventName) return false
  if (MATCHER_IGNORED_EVENTS.has(request.eventName)) return true
  if (hook.matcher === '*') return true
  return hook.matcherRegex?.test(request.matcherValue ?? '') ?? false
}

async function executeHookCommand(
  hook: ResolvedHookDefinition,
  request: HookRunRequest
): Promise<{ blocked: boolean; reason?: string; output?: HookOutput }> {
  const startedAt = Date.now()
  const hookRunId = newId('hook-run')
  const payload = buildHookPayload(hook, request, hookRunId)
  const boundedPayload = boundPayload(payload)
  const stdinText = JSON.stringify(boundedPayload)
  const command = hook.resolvedCommand
  let status: HookRunStatus = HOOK_RUN_STATUS.completed
  let exitCode: number | undefined
  let stdoutPreview = ''
  let stderrPreview = ''
  let decision: unknown
  let error: string | undefined
  let output: HookOutput | undefined
  let blocked = false
  let reason: string | undefined

  await acquireHookSlot()
  try {
    const execution = await spawnHookCommand({
      command,
      cwd: hook.resolvedCwd,
      env: buildHookEnv(hook, request, hookRunId),
      stdinText,
      timeoutMs: hook.timeoutSeconds * 1000,
      cancellationKey: request.cancellationKey
    })
    exitCode = execution.exitCode
    stdoutPreview = execution.stdout
    stderrPreview = execution.stderr

    if (execution.canceled || isHookRunCanceled(request)) {
      status = HOOK_RUN_STATUS.failed
      error = 'Hook canceled'
    } else if (execution.timedOut) {
      status = HOOK_RUN_STATUS.timeout
      error = `Hook timed out after ${hook.timeoutSeconds}s`
    } else if (exitCode === 2) {
      status = HOOK_RUN_STATUS.blocked
      blocked = true
      reason = stderrPreview.trim() || 'Blocked by hook'
    } else if (exitCode && exitCode !== 0) {
      status = HOOK_RUN_STATUS.failed
      error = stderrPreview.trim() || `Hook exited with code ${exitCode}`
    } else {
      const parsed = parseHookOutput(stdoutPreview)
      if (parsed.error) {
        status = HOOK_RUN_STATUS.failed
        error = parsed.error
      } else {
        output = parsed.output
        decision = output
        const outputBlock = readBlockDecision(output)
        if (outputBlock.blocked) {
          status = HOOK_RUN_STATUS.blocked
          blocked = true
          reason = outputBlock.reason
        }
      }
    }
  } catch (caught) {
    status = HOOK_RUN_STATUS.failed
    error = normalizeError(caught)
  } finally {
    releaseHookSlot()
    const completedAt = Date.now()
    await auditHookRun({
      hook,
      request,
      status,
      startedAt,
      completedAt,
      exitCode,
      stdoutPreview,
      stderrPreview,
      decision,
      error
    })
  }

  return { blocked, reason, output }
}

function buildHookPayload(
  hook: ResolvedHookDefinition,
  request: HookRunRequest,
  hookRunId: string
): Record<string, unknown> {
  const workspaceTarget = request.sshConnectionId ? 'ssh' : request.projectRoot ? 'local' : 'none'
  return {
    ...request.input,
    hookEventName: request.eventName,
    hookRunId,
    appVersion: app.getVersion(),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    ...(request.runId ? { runId: request.runId } : {}),
    cwd: hook.resolvedCwd,
    hookSource: {
      kind: hook.sourceKind,
      path: hook.sourcePath,
      ...(hook.projectRoot ? { projectRoot: hook.projectRoot } : {})
    },
    hook: {
      eventName: hook.eventName,
      matcher: hook.matcher,
      definitionHash: hook.definitionHash,
      trustKey: hook.trustKey
    },
    workspace: {
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.projectRoot ? { workingFolder: request.projectRoot } : {}),
      target: workspaceTarget
    }
  }
}

function boundPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(payload)
  if (Buffer.byteLength(text, 'utf8') <= MAX_STDIN_BYTES) return payload

  const bounded = { ...payload }
  if (typeof bounded.prompt === 'string') {
    bounded.prompt = truncateText(bounded.prompt, 16 * 1024)
  }
  if ('toolInput' in bounded) {
    bounded.toolInput = { truncated: true, reason: 'hook payload exceeded input limit' }
  }
  if ('toolResponse' in bounded) {
    bounded.toolResponse = { truncated: true, reason: 'hook payload exceeded input limit' }
  }
  const nextText = JSON.stringify(bounded)
  if (Buffer.byteLength(nextText, 'utf8') <= MAX_STDIN_BYTES) return bounded
  return {
    hookEventName: payload.hookEventName,
    hookRunId: payload.hookRunId,
    appVersion: payload.appVersion,
    sessionId: payload.sessionId,
    runId: payload.runId,
    cwd: payload.cwd,
    hookSource: payload.hookSource,
    hook: payload.hook,
    workspace: payload.workspace,
    truncated: true
  }
}

function buildHookEnv(
  hook: ResolvedHookDefinition,
  request: HookRunRequest,
  hookRunId: string
): NodeJS.ProcessEnv {
  const allowedKeys = ['PATH', 'HOME', 'USER', 'USERNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG']
  const env: NodeJS.ProcessEnv = {}
  for (const key of allowedKeys) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return {
    ...env,
    ...hook.env,
    OPENCOWORK_HOOK: '1',
    OPENCOWORK_HOOK_EVENT: request.eventName,
    OPENCOWORK_HOOK_SOURCE_KIND: hook.sourceKind,
    OPENCOWORK_HOOK_SOURCE_PATH: hook.sourcePath,
    OPENCOWORK_HOOK_RUN_ID: hookRunId,
    ...(request.sessionId ? { OPENCOWORK_HOOK_SESSION_ID: request.sessionId } : {})
  }
}

function spawnHookCommand(args: {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  stdinText: string
  timeoutMs: number
  cancellationKey?: string
}): Promise<{
  exitCode: number | undefined
  stdout: string
  stderr: string
  timedOut: boolean
  canceled: boolean
}> {
  return new Promise((resolve, reject) => {
    if (args.cancellationKey && canceledHookRunKeys.has(args.cancellationKey)) {
      resolve({ exitCode: undefined, stdout: '', stderr: '', timedOut: false, canceled: true })
      return
    }
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const shellArgs =
      process.platform === 'win32' ? ['/d', '/s', '/c', args.command] : ['-lc', args.command]
    const child = spawn(shell, shellArgs, {
      cwd: args.cwd,
      env: args.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let canceled = false
    const unregisterProcess = args.cancellationKey
      ? registerActiveHookProcess(args.cancellationKey, child)
      : () => {}
    if (args.cancellationKey && canceledHookRunKeys.has(args.cancellationKey)) {
      canceled = true
      terminateHookProcess(child.pid)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminateHookProcess(child.pid)
    }, args.timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      unregisterProcess()
      reject(error)
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendPreview(stdout, chunk.toString('utf8'), MAX_STDOUT_PREVIEW_CHARS)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendPreview(stderr, chunk.toString('utf8'), MAX_STDERR_PREVIEW_CHARS)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      unregisterProcess()
      resolve({ exitCode: code ?? undefined, stdout, stderr, timedOut, canceled })
    })
    child.stdin?.end(args.stdinText)
  })
}

function registerActiveHookProcess(cancellationKey: string, child: ChildProcess): () => void {
  let processes = activeHookProcessesByKey.get(cancellationKey)
  if (!processes) {
    processes = new Set<ChildProcess>()
    activeHookProcessesByKey.set(cancellationKey, processes)
  }
  processes.add(child)
  return () => {
    processes?.delete(child)
    if (processes?.size === 0) {
      activeHookProcessesByKey.delete(cancellationKey)
    }
  }
}

function isHookRunCanceled(request: HookRunRequest): boolean {
  return !!request.cancellationKey && canceledHookRunKeys.has(request.cancellationKey)
}

function terminateHookProcess(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGTERM')
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* already exited */
        }
      }, 1500)
    }
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already exited */
    }
  }
}

function appendPreview(current: string, next: string, limit: number): string {
  if (current.length >= limit) return current
  const combined = current + next
  if (combined.length <= limit) return combined
  const marker = '\n[truncated]'
  return `${combined.slice(0, Math.max(0, limit - marker.length))}${marker}`
}

function parseHookOutput(stdout: string): { output?: HookOutput; error?: string } {
  const trimmed = stdout.trim()
  if (!trimmed) return { output: {} }
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'Hook stdout JSON must be an object' }
    }
    return { output: parsed as HookOutput }
  } catch (error) {
    return { error: `Failed to parse hook stdout JSON: ${normalizeError(error)}` }
  }
}

function readBlockDecision(output: HookOutput | undefined): { blocked: boolean; reason?: string } {
  const record = readRecord(output)
  if (record?.decision === HOOK_DECISION.block) {
    return {
      blocked: true,
      reason: typeof record.reason === 'string' ? record.reason : 'Blocked by hook'
    }
  }
  return { blocked: false }
}

function mergeExecutionResult(
  result: HookRunResult,
  output: HookOutput | undefined,
  eventName: HookEventName
): void {
  if (!output) return
  if (output.systemMessage) result.systemMessages?.push(output.systemMessage)
  const specific = readRecord((output as { hookSpecificOutput?: unknown }).hookSpecificOutput)
  if (typeof specific?.additionalContext === 'string') {
    result.additionalContext?.push(specific.additionalContext)
  }
  if (eventName === HOOK_EVENTS.userPromptSubmit && typeof specific?.updatedPrompt === 'string') {
    result.updatedPrompt = specific.updatedPrompt
  }
  const updatedInput = readRecord(specific?.updatedInput)
  if (eventName === HOOK_EVENTS.preToolUse && updatedInput) {
    result.updatedInput = updatedInput
  }
  if (eventName === HOOK_EVENTS.postToolUse && specific && 'replacementToolFeedback' in specific) {
    result.replacementToolFeedback = specific?.replacementToolFeedback
  }
  if (eventName === HOOK_EVENTS.permissionRequest) {
    const decision = readRecord(specific?.decision) as HookRunDecision | null
    if (decision?.behavior === HOOK_PERMISSION_BEHAVIOR.deny) {
      result.permissionDecision = decision
    } else if (
      decision?.behavior === HOOK_PERMISSION_BEHAVIOR.allow &&
      result.permissionDecision?.behavior !== HOOK_PERMISSION_BEHAVIOR.deny
    ) {
      result.permissionDecision = decision
    }
  }
}

async function auditHookRun(args: {
  hook: ResolvedHookDefinition
  request: HookRunRequest
  status: HookRunStatus
  startedAt?: number
  completedAt?: number
  exitCode?: number
  skippedReason?: string
  stdoutPreview?: string
  stderrPreview?: string
  decision?: unknown
  error?: string
}): Promise<void> {
  const startedAt = args.startedAt ?? Date.now()
  const completedAt = args.completedAt ?? startedAt
  await insertHookRun({
    id: newId('hook-run-record'),
    trustKey: args.hook.trustKey,
    runId: args.request.runId ?? null,
    sessionId: args.request.sessionId ?? null,
    eventName: args.request.eventName,
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - startedAt),
    status: args.status,
    exitCode: args.exitCode ?? null,
    skippedReason: args.skippedReason ?? null,
    stdoutPreview: args.stdoutPreview ? truncateText(args.stdoutPreview, 4000) : null,
    stderrPreview: args.stderrPreview ? truncateText(args.stderrPreview, 4000) : null,
    decisionJson:
      args.decision === undefined ? null : truncateText(JSON.stringify(args.decision), 4000),
    error: args.error ?? null,
    retainedUntil: Date.now() + 30 * 24 * 60 * 60 * 1000
  }).catch((error) => {
    console.warn('[Hooks] failed to audit hook run:', normalizeError(error))
  })
}

async function acquireHookSlot(): Promise<void> {
  if (activeHookProcesses < MAX_TOTAL_CONCURRENT_HOOKS) {
    activeHookProcesses += 1
    return
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve))
  activeHookProcesses += 1
}

function releaseHookSlot(): void {
  activeHookProcesses = Math.max(0, activeHookProcesses - 1)
  const next = waitQueue.shift()
  if (next) next()
}
